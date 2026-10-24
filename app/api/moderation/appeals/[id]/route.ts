/**
 * app/api/moderation/appeals/[id]/route.ts — Appeal review actions
 *
 * PATCH — claim, unclaim, or resolve an APPEAL review item.
 *
 * ADR-024. RBAC (F6): gated on "can_moderate". Scoped to appeal items only —
 * the target must exist and have source "appeal" (escalations and ban reviews
 * are managed under /api/moderation/review/[id]). Reviewer identity is the
 * verified moderator (requireAdmin), never the request body.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import {
  claimItem,
  unclaimItem,
  resolveItem,
} from "@/platform/moderation/review-service";
import { getReviewQueueStore } from "@/platform/moderation/review-store";
import type { ReviewDecision } from "@/platform/moderation/review-types";
import type { ModerationAction } from "@/platform/moderation/types";
import { apiError, errorFromResult, readJsonObject } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";

const MODERATE_PERMISSION = "can_moderate";

export const PATCH = tenantRoute(async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const verified = await requireAdmin(request, MODERATE_PERMISSION);
  if (verified.error) return verified.error;
  // The reviewer is the verified moderator's users.id — the id space of target_user_id — never
  // a value from the body, and never a placeholder (audit X-8).
  const reviewerId = verified.admin.userId;

  const requestId = generateRequestId();
  const { id } = await context.params;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as {
    action?: string;
    decision?: ReviewDecision;
    reviewerNotes?: string;
    modifiedAction?: ModerationAction;
  };

  try {
    // Scope guard: this endpoint only operates on appeal items.
    const item = await getReviewQueueStore().getById(id);
    if (!item || item.source !== "appeal") {
      return apiError("moderation.appeal_not_found", { request });
    }

    switch (body.action) {
      case "claim": {
        const result = await claimItem(id, reviewerId);
        if (!result.success) {
          return errorFromResult(result, { request });
        }
        return NextResponse.json({ item: result.item });
      }
      case "unclaim": {
        const result = await unclaimItem(id, reviewerId);
        if (!result.success) {
          return errorFromResult(result, { request });
        }
        return NextResponse.json({ item: result.item });
      }
      case "resolve": {
        if (!body.decision || !body.reviewerNotes) {
          return apiError("request.missing_fields", {
            params: { fields: ["decision", "reviewerNotes"] },
            request,
          });
        }
        const result = await resolveItem({
          itemId: id,
          reviewerId,
          decision: body.decision,
          reviewerNotes: body.reviewerNotes,
          modifiedAction: body.modifiedAction,
        });
        if (!result.success) {
          return errorFromResult(result, { request });
        }
        return NextResponse.json({ item: result.item });
      }
      default:
        return apiError("request.invalid_value", {
          params: { field: "action", allowed: ["claim", "unclaim", "resolve"] },
          request,
        });
    }
  } catch (err) {
    logger.error("Appeal action error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      reviewItemId: id,
      action: body.action,
      route: "api/moderation/appeals/[id]",
    });
    return apiError("internal.error", { params: { requestId }, request });
  }
});
