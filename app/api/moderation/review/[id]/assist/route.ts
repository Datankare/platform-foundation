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
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import { getReviewQueueStore } from "@/platform/moderation/review-store";
import { generateReviewRecommendation } from "@/platform/moderation/review-assist";

const MODERATE_PERMISSION = "can_moderate";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const denied = await adminGuard(request, MODERATE_PERMISSION);
  if (denied) return denied;

  const requestId = generateRequestId();
  const { id } = await context.params;

  try {
    const item = await getReviewQueueStore().getById(id);
    if (!item) {
      return NextResponse.json({ error: "Review item not found" }, { status: 404 });
    }

    const recommendation = await generateReviewRecommendation(item, requestId);
    return NextResponse.json({ recommendation });
  } catch (err) {
    logger.error("Review assist route error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      reviewItemId: id,
      route: "api/moderation/review/[id]/assist",
    });
    return NextResponse.json({ error: "Failed to generate suggestion" }, { status: 500 });
  }
}
