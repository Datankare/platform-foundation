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
import type { AccountStatus, ModerationResult } from "@/platform/moderation/types";
import type { ExplanationChain } from "@/platform/rag/types";

const MODERATE_PERMISSION = "can_moderate";

/** Sources an admin may submit manually here. Appeals use the appeals route. */
const VALID_SUBMIT_SOURCES: readonly ReviewItemSource[] = ["escalation", "ban_review"];

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
    if (Number.isFinite(n) && n > 0) options.limit = n;
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

    const options = buildQueryOptions(request.nextUrl.searchParams);
    const items = await getQueue(options);
    return NextResponse.json({ items });
  } catch (err) {
    logger.error("Review queue list error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/moderation/review",
    });
    return NextResponse.json({ error: "Failed to load review queue" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await adminGuard(request, MODERATE_PERMISSION);
  if (denied) return denied;

  const requestId = generateRequestId();

  let body: {
    source?: ReviewItemSource;
    moderationResult?: unknown;
    targetUserId?: string;
    explanationChain?: unknown;
    previousAccountStatus?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { source, moderationResult, targetUserId } = body;

  if (!source || !moderationResult || !targetUserId) {
    return NextResponse.json(
      { error: "source, moderationResult, and targetUserId are required" },
      { status: 400 }
    );
  }
  if (!VALID_SUBMIT_SOURCES.includes(source)) {
    return NextResponse.json(
      {
        error: `source must be one of: ${VALID_SUBMIT_SOURCES.join(
          ", "
        )} (appeals use /api/moderation/appeals)`,
      },
      { status: 400 }
    );
  }

  try {
    const result = await submitForReview({
      source,
      moderationResult: moderationResult as ModerationResult,
      targetUserId,
      requestId,
      explanationChain: body.explanationChain as ExplanationChain | undefined,
      previousAccountStatus: body.previousAccountStatus as AccountStatus | undefined,
    });

    if (!result.success) {
      logger.error("Review queue submit failed", {
        error: result.error,
        requestId,
        route: "api/moderation/review",
      });
      return NextResponse.json(
        { error: result.error ?? "Submit failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({ item: result.item }, { status: 201 });
  } catch (err) {
    logger.error("Review queue submit error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/moderation/review",
    });
    return NextResponse.json({ error: "Failed to submit for review" }, { status: 500 });
  }
}
