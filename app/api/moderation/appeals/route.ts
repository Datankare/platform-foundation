/**
 * app/api/moderation/appeals/route.ts — A user's own decisions, and their appeals
 *
 * GET  — the blocks of the caller's own content, newest first, each with its appeal if one was
 *        filed, and the appeal rules (window, reason length): what the account page lists, so a
 *        user can find the decision they appeal (TASK-210, N-117 — no screen could).
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
import { withTenantTx } from "@/platform/data";
import { getModerationStore } from "@/platform/moderation/store";
import { getAuditLogForUser } from "@/platform/auth/audit";
import {
  listOwnDecisions,
  noOwnDecisions,
  submitAppeal,
} from "@/platform/moderation/review-service";
import { logger, generateRequestId } from "@/lib/logger";
import type {
  AccountStatus,
  ModerationAuditRecord,
  ModerationResult,
} from "@/platform/moderation/types";
import {
  apiError,
  errorFromResult,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { sameId } from "@/platform/auth/same-id";
import { type ResponseSchema, SHOWN, stored } from "@/platform/errors/response-schema";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const APPEAL_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    originalDecisionId: { type: "string" },
    appealReason: { type: "string" },
  },
};

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "warned",
  "restricted",
  "suspended",
  "banned",
]);

/**
 * Resolve a Cognito sub to the app users.id (active users only), in the request's tenant: an
 * appeal is the tenant's own data (ADR-053 D5). An unreadable lookup resolves to no one.
 */
async function resolveUserId(sub: string): Promise<string | null> {
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ id: string }>(
        "select id from users where cognito_sub = $1 and deleted_at is null",
        [sub]
      )
    );
    return rows.length === 1 ? rows[0].id : null;
  } catch {
    return null;
  }
}

/**
 * Who the caller is, for reading their own decisions (TASK-224): their account; none yet (a
 * signed-in identity whose row its first guarded request makes — TASK-117); erased (a row closed
 * by its deletion: `account.not_found`, as before); or not known, the lookup failing — never read
 * as "none" (a failed read is not an empty list).
 */
async function ownAccount(
  sub: string
): Promise<
  | { readonly kind: "account"; readonly id: string }
  | { readonly kind: "none" | "erased" | "unreadable" }
> {
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ id: string; deleted: boolean }>(
        "select id, deleted_at is not null as deleted from users where cognito_sub = $1",
        [sub]
      )
    );
    if (rows.length === 0) return { kind: "none" };
    const live = rows.filter((r) => !r.deleted);
    if (live.length === 1) return { kind: "account", id: live[0]!.id };
    return live.length === 0 ? { kind: "erased" } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
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
        (sameId(details.guardianDecisionId, trajectoryId) ||
          sameId(details.trajectoryId, trajectoryId)) &&
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

/**
 * The caller's own decisions (TASK-210). Signed in only (requireAuth: a guest has no account to
 * appeal for); the account is the verified token's, never a parameter — the route reads none. Not
 * gated on the account's standing: a restricted, suspended or banned account still sees its
 * decisions and appeals them (the decision under appeal is often why it is restricted).
 */
const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    appealWindowHours: {
      type: "number",
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          appeal: {
            type: ["null", "object"],
            properties: {
              decision: {
                type: "string",
              },
              modifiedAction: {
                type: "string",
              },
              resolvedAt: {
                type: "string",
              },
              status: {
                type: "string",
              },
              submittedAt: {
                type: "string",
              },
            },
          },
          appealableUntil: {
            type: "string",
          },
          contentType: {
            type: "string",
          },
          // Why it was blocked, as a kind (TASK-224, SF-app-060) — never the screened text.
          reason: {
            type: "string",
          },
          decidedAt: {
            type: "string",
          },
          id: {
            type: "string",
          },
        },
      },
    },
    maxReasonLength: {
      type: "number",
    },
    minReasonLength: {
      type: "number",
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL);
  if (limited) return limited;
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const own = await ownAccount(auth.user.sub);
  if (own.kind === "erased") return apiError("account.not_found", { request });
  if (own.kind === "unreadable")
    return apiError("service.unavailable", {
      params: { service: "moderation" },
      request,
    });

  try {
    // No row yet (its first guarded request makes it): no decisions — never "account not found",
    // which a page reads as an erased account and signs out (TASK-224: the account page can be
    // the first page after sign-in, E-113).
    if (own.kind !== "account") return NextResponse.json(await noOwnDecisions());
    return NextResponse.json(await listOwnDecisions(own.id));
  } catch (err) {
    logger.error("Own decisions read failed", {
      error: err instanceof Error ? err.message : "Unknown",
      route: "api/moderation/appeals",
    });
    return apiError("service.unavailable", {
      params: { service: "moderation" },
      request,
    });
  }
}, GET_RESPONSE);

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    item: {
      type: "object",
      properties: {
        appealReason: {
          type: "string",
        },
        claimedAt: {
          type: "string",
        },
        claimedBy: {
          type: "string",
        },
        createdAt: {
          type: "string",
        },
        decision: {
          type: "string",
        },
        explanationChain: stored(
          "a moderation decision's stored explanation chain: each phase and the platform's notes as catalogue keys"
        ),
        id: {
          type: "string",
        },
        moderationResult: stored(
          "a moderation decision's stored record (review_queue.moderation_result): its action, categories and the platform's notes as catalogue keys"
        ),
        modifiedAction: {
          type: "string",
        },
        notesShown: SHOWN,
        originalDecisionId: {
          type: "string",
        },
        previousAccountStatus: {
          type: "string",
        },
        priority: {
          type: "string",
        },
        relatedStrikeId: {
          type: "string",
        },
        requestId: {
          type: "string",
        },
        resolvedAt: {
          type: "string",
        },
        resolvedBy: {
          type: "string",
        },
        reviewerNotes: {
          type: "string",
        },
        source: {
          type: "string",
        },
        status: {
          type: "string",
        },
        targetUserId: {
          type: "string",
        },
        updatedAt: {
          type: "string",
        },
      },
    },
  },
};

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL);
  if (limited) return limited;
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const requestId = generateRequestId();

  const read = await readJsonBody(request, APPEAL_BODY_SCHEMA);
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
    if (!sameId(original.userId, appealingUserId)) {
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
}, POST_RESPONSE);
