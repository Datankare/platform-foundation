/**
 * app/api/moderation/review/route.ts — Human review queue (list + submit)
 *
 * GET  — list/filter the review queue, or queue statistics with ?view=stats
 * POST — manually submit an item for review (escalation or ban_review)
 *
 * ADR-024. RBAC (F6): every handler is gated on "can_moderate" — admin /
 * moderator only. P10: this is a human-oversight surface. P11: failures return
 * structured JSON errors rather than throwing.
 *
 * Appeals are NOT submitted here — they have their own endpoint
 * (/api/moderation/appeals) which enforces appeal eligibility + identity.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import {
  getQueue,
  getQueueStats,
  submitForReview,
} from "@/platform/moderation/review-service";
import type {
  ReviewItemSource,
  ReviewQueryOptions,
} from "@/platform/moderation/review-types";
import type { ModerationResult } from "@/platform/moderation/types";
import type { ExplanationChain } from "@/platform/rag/types";
import { apiError, errorFromResult, readJsonObject } from "@/platform/errors";

const MODERATE_PERMISSION = "can_moderate";
/** Most queue items one list request returns. */
const MAX_LIST = 200;

/** Sources an admin may submit manually here. Appeals use the appeals route. */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a moderator may submit by hand. ban_review items are created only by Sentinel, which
 * records the account's real previous status; a hand-made one could name any previous status
 * and be overturned into it (audit X-2). Appeals have their own endpoint.
 */
const VALID_SUBMIT_SOURCES: readonly ReviewItemSource[] = ["escalation"];

/**
 * The fields of a moderation result the review pipeline reads. A hand-submitted result that
 * lacks them would fail later, inside the service, as an uncoded error (release review).
 */
function isModerationResultShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.action === "string" &&
    ["allow", "warn", "block", "escalate"].includes(m.action) &&
    typeof m.reasoning === "string" &&
    typeof m.trajectoryId === "string" &&
    Array.isArray(m.contextFactors) &&
    Array.isArray(m.blocklistMatches)
  );
}

/** Translate query-string params into ReviewQueryOptions (only present keys). */
function buildQueryOptions(params: URLSearchParams): ReviewQueryOptions {
  const options: {
    status?: ReviewQueryOptions["status"];
    source?: ReviewQueryOptions["source"];
    priority?: ReviewQueryOptions["priority"];
    targetUserId?: string;
    claimedBy?: string;
    since?: string;
    before?: string;
    limit?: number;
  } = {};

  const status = params.get("status");
  if (status) options.status = status as ReviewQueryOptions["status"];
  const source = params.get("source");
  if (source) options.source = source as ReviewQueryOptions["source"];
  const priority = params.get("priority");
  if (priority) options.priority = priority as ReviewQueryOptions["priority"];
  const targetUserId = params.get("targetUserId");
  if (targetUserId) options.targetUserId = targetUserId;
  const claimedBy = params.get("claimedBy");
  if (claimedBy) options.claimedBy = claimedBy;
  const since = params.get("since");
  if (since) options.since = since;
  const before = params.get("before");
  if (before) options.before = before;
  const limit = params.get("limit");
  if (limit) {
    const n = Number.parseInt(limit, 10);
    if (Number.isFinite(n) && n > 0) options.limit = Math.min(n, MAX_LIST);
  }

  return options;
}

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, MODERATE_PERMISSION);
  if (denied) return denied;

  const requestId = generateRequestId();

  try {
    if (request.nextUrl.searchParams.get("view") === "stats") {
      const stats = await getQueueStats();
      return NextResponse.json({ stats });
    }

    // User filters are ids: anything else is refused, not sent to the database (where a
    // non-UUID against a uuid column is an error, not "no match").
    for (const field of ["targetUserId", "claimedBy"] as const) {
      const v = request.nextUrl.searchParams.get(field);
      if (v && !USER_ID.test(v)) {
        return apiError("request.invalid_value", {
          params: { field, allowed: ["a user id"] },
          request,
        });
      }
    }
    const options = buildQueryOptions(request.nextUrl.searchParams);
    const items = await getQueue(options);
    return NextResponse.json({ items });
  } catch (err) {
    logger.error("Review queue list error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/moderation/review",
    });
    return apiError("internal.error", { request });
  }
}

export async function POST(request: NextRequest) {
  const denied = await adminGuard(request, MODERATE_PERMISSION);
  if (denied) return denied;

  const requestId = generateRequestId();

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as {
    source?: ReviewItemSource;
    moderationResult?: unknown;
    targetUserId?: string;
    explanationChain?: unknown;
  };

  const { source, moderationResult, targetUserId } = body;

  if (!source || !moderationResult || !targetUserId) {
    return apiError("request.missing_fields", {
      params: { fields: ["source", "moderationResult", "targetUserId"] },
      request,
    });
  }
  if (typeof targetUserId !== "string" || !USER_ID.test(targetUserId)) {
    return apiError("request.invalid_value", {
      params: { field: "targetUserId", allowed: ["a user id"] },
      request,
    });
  }
  if (!isModerationResultShape(moderationResult)) {
    return apiError("request.invalid_body", { request });
  }
  if (!VALID_SUBMIT_SOURCES.includes(source)) {
    return apiError("request.invalid_value", {
      params: { field: "source", allowed: [...VALID_SUBMIT_SOURCES] },
      request,
    });
  }

  try {
    const result = await submitForReview({
      source,
      moderationResult: moderationResult as ModerationResult,
      targetUserId,
      requestId,
      explanationChain: body.explanationChain as ExplanationChain | undefined,
    });

    if (!result.success) {
      logger.error("Review queue submit failed", {
        error: result.error,
        requestId,
        route: "api/moderation/review",
      });
      return errorFromResult(result, { request, context: "Review queue submit failed" });
    }

    return NextResponse.json({ item: result.item }, { status: 201 });
  } catch (err) {
    logger.error("Review queue submit error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/moderation/review",
    });
    return apiError("internal.error", { params: { requestId }, request });
  }
}
