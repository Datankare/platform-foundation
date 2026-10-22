/**
 * app/api/moderation/review/[id]/assist/route.ts — AI reviewer assist
 *
 * POST — generate a NON-BINDING recommendation for a review item.
 *
 * ADR-025. RBAC (F6): gated on "can_moderate". The item is read server-side by
 * id; the service is fail-open, so a model outage yields { recommendation: null }
 * (HTTP 200) rather than an error — the assist is advisory and must never block
 * the review workflow (P10/P11).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { enforceDailyPaidQuota } from "@/platform/rate-limit";
import { logger, generateRequestId } from "@/lib/logger";
import { getReviewQueueStore } from "@/platform/moderation/review-store";
import { generateReviewRecommendation } from "@/platform/moderation/review-assist";
import { apiError } from "@/platform/errors";

const MODERATE_PERMISSION = "can_moderate";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const verified = await requireAdmin(request, MODERATE_PERMISSION);
  if (verified.error) return verified.error;
  const { admin } = verified;

  const requestId = generateRequestId();
  const { id } = await context.params;

  try {
    const item = await getReviewQueueStore().getById(id);
    if (!item) {
      return apiError("moderation.review_item_not_found", { request });
    }
    // No assist on a case about the moderator's own account (as claim and resolve).
    if (item.targetUserId === admin.userId) {
      return apiError("moderation.self_review", { request });
    }
    // A paid model call: counted against the moderator's daily quota (release review).
    const quota = await enforceDailyPaidQuota(request, admin.userId);
    if (quota) return quota;

    const recommendation = await generateReviewRecommendation(item, requestId);
    return NextResponse.json({ recommendation });
  } catch (err) {
    logger.error("Review assist route error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      reviewItemId: id,
      route: "api/moderation/review/[id]/assist",
    });
    return apiError("internal.error", { params: { requestId }, request });
  }
}
