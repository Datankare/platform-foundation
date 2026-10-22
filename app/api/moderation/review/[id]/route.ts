/**
 * app/api/moderation/review/[id]/route.ts — Review item actions
 *
 * PATCH — claim, unclaim, or resolve a single review item.
 *
 * ADR-024. RBAC (F6): gated on "can_moderate". The reviewer identity is the
 * verified moderator (requireAdmin) — NEVER the request body — so
 * claim/resolve ownership cannot be spoofed by a caller. P17: claim is cognition
 * (reversible), resolve is commitment (durable side effects).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import {
  claimItem,
  unclaimItem,
  resolveItem,
} from "@/platform/moderation/review-service";
import type { ReviewDecision } from "@/platform/moderation/review-types";
import type { ModerationAction } from "@/platform/moderation/types";
import { apiError, errorFromResult, readJsonObject } from "@/platform/errors";

const MODERATE_PERMISSION = "can_moderate";

export async function PATCH(
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
    logger.error("Review item action error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      reviewItemId: id,
      action: body.action,
      route: "api/moderation/review/[id]",
    });
    return apiError("internal.error", { params: { requestId }, request });
  }
}
