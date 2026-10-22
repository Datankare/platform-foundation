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
import { apiError, errorFromResult, readJsonObject } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

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
        (details.type === "sentinel_status_change" ||
          details.type === "sentinel_decision") &&
        // The appealed decision is the Guardian's; Sentinel records it as guardianDecisionId
        // (its own run id is trajectoryId, which never matched — Sprint 7X).
        (details.guardianDecisionId === trajectoryId ||
          details.trajectoryId === trajectoryId) &&
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

export async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL);
  if (limited) return limited;
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const requestId = generateRequestId();

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const { originalDecisionId, appealReason } = read.body;
  if (
    typeof originalDecisionId !== "string" ||
    !originalDecisionId ||
    typeof appealReason !== "string" ||
    !appealReason
  ) {
    return apiError("request.missing_fields", {
      params: { fields: ["originalDecisionId", "appealReason"] },
      request,
    });
  }

  const appealingUserId = await resolveUserId(auth.user.sub);
  if (!appealingUserId) {
    return apiError("account.not_found", { request });
  }

  try {
    // Authoritative original decision — fetched server-side, never from client.
    const records = await getModerationStore().queryAudits({
      trajectoryId: originalDecisionId,
      limit: 1,
    });
    const original = records[0];
    if (!original) {
      return apiError("moderation.decision_not_found", { request });
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
      return apiError("moderation.not_own_decision", { request });
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
      return errorFromResult(result, { request });
    }

    return NextResponse.json({ item: result.item }, { status: 201 });
  } catch (err) {
    logger.error("Appeal submission error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/moderation/appeals",
    });
    return apiError("internal.error", { params: { requestId }, request });
  }
}
