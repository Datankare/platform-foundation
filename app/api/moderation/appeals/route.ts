/**
 * app/api/moderation/appeals/route.ts — User appeal submission
 *
 * POST — a user appeals a block/ban decision made against their own content.
 *
 * ADR-024. Security (F6 + injection defense):
 *   - The appellant is taken from the VERIFIED TOKEN, resolved to an app user id
 *     via cognito_sub — never trusted from the request body.
 *   - The original decision is fetched SERVER-SIDE by trajectory id; its owner
 *     must equal the appellant (no cross-user appeals).
 *   - The appeal window is enforced against the decision's recorded timestamp,
 *     not any client-supplied value.
 *   - previousAccountStatus (for F1 overturn restoration) is recovered
 *     best-effort from the Sentinel's platform-audit entry.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/platform/auth/middleware";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { getModerationStore } from "@/platform/moderation/store";
import { getAuditLogForUser } from "@/platform/auth/audit";
import { submitAppeal } from "@/platform/moderation/review-service";
import { logger, generateRequestId } from "@/lib/logger";
import type {
  AccountStatus,
  ModerationAuditRecord,
  ModerationResult,
} from "@/platform/moderation/types";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "warned",
  "restricted",
  "suspended",
  "banned",
]);

/** Resolve a Cognito sub to the app users.id (active users only). */
async function resolveUserId(sub: string): Promise<string | null> {
  try {
    const supabase = getSupabaseServiceClient();
    const { data, error } = await supabase
      .from("users")
      .select("id")
      .eq("cognito_sub", sub)
      .is("deleted_at", null)
      .single();
    if (error || !data) return null;
    return (data as { id: string }).id;
  } catch {
    return null;
  }
}

/** Rebuild a ModerationResult from a stored audit record. */
function auditToModerationResult(record: ModerationAuditRecord): ModerationResult {
  return {
    action: record.actionTaken,
    triggeredBy: record.triggeredBy,
    direction: record.direction,
    contentType: record.contentType,
    contentRatingLevel: record.contentRatingLevel,
    blocklistMatches: [],
    classifierOutput: record.classifierOutput,
    reasoning: record.reasoning,
    severityAdjustment: record.severityAdjustment,
    contextFactors: record.contextFactors,
    attributeToUser: record.attributeToUser,
    pipelineLatencyMs: record.pipelineLatencyMs,
    classifierCostUsd: record.classifierCostUsd,
    trajectoryId: record.trajectoryId,
    agentId: record.agentId,
  };
}

/**
 * Best-effort recovery of the account status BEFORE the appealed decision, from
 * the Sentinel's platform-audit entry (details.previousStatus). Lets an overturn
 * restore the correct status (F1). Returns undefined when not found.
 */
async function derivePreviousStatus(
  userId: string,
  trajectoryId: string
): Promise<AccountStatus | undefined> {
  try {
    const entries = await getAuditLogForUser(userId, 100);
    for (const entry of entries) {
      const details: Record<string, unknown> = entry.details ?? {};
      if (
        details.type === "sentinel_decision" &&
        details.trajectoryId === trajectoryId &&
        typeof details.previousStatus === "string" &&
        VALID_STATUSES.has(details.previousStatus)
      ) {
        return details.previousStatus as AccountStatus;
      }
    }
  } catch {
    /* best-effort — fall through to undefined */
  }
  return undefined;
}

function appealErrorStatus(error: string): number {
  if (error.includes("already pending")) return 409;
  return 400;
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const requestId = generateRequestId();

  let body: { originalDecisionId?: string; appealReason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { originalDecisionId, appealReason } = body;
  if (!originalDecisionId || !appealReason) {
    return NextResponse.json(
      { error: "originalDecisionId and appealReason are required" },
      { status: 400 }
    );
  }

  const appealingUserId = await resolveUserId(auth.user.sub);
  if (!appealingUserId) {
    return NextResponse.json({ error: "User account not found" }, { status: 403 });
  }

  try {
    // Authoritative original decision — fetched server-side, never from client.
    const records = await getModerationStore().queryAudits({
      trajectoryId: originalDecisionId,
      limit: 1,
    });
    const original = records[0];
    if (!original) {
      return NextResponse.json({ error: "Original decision not found" }, { status: 404 });
    }

    // Ownership (F6): a user may only appeal their own decision.
    if (original.userId !== appealingUserId) {
      logger.warn("Appeal ownership mismatch", {
        appealingUserId,
        decisionOwner: original.userId ?? "unknown",
        trajectoryId: originalDecisionId,
        requestId,
        route: "api/moderation/appeals",
      });
      return NextResponse.json(
        { error: "You can only appeal your own moderation decisions" },
        { status: 403 }
      );
    }

    const previousAccountStatus = await derivePreviousStatus(
      appealingUserId,
      originalDecisionId
    );

    const result = await submitAppeal(
      {
        originalDecisionId,
        moderationResult: auditToModerationResult(original),
        appealingUserId,
        appealReason,
        requestId,
        previousAccountStatus,
      },
      original.timestamp
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: appealErrorStatus(result.error ?? "") }
      );
    }

    return NextResponse.json({ item: result.item }, { status: 201 });
  } catch (err) {
    logger.error("Appeal submission error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/moderation/appeals",
    });
    return NextResponse.json({ error: "Failed to submit appeal" }, { status: 500 });
  }
}
