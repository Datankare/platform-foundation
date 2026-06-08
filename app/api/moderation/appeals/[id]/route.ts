/**
 * app/api/moderation/appeals/[id]/route.ts — Appeal review actions
 *
 * PATCH — claim, unclaim, or resolve an APPEAL review item.
 *
 * ADR-024. RBAC (F6): gated on "can_moderate". Scoped to appeal items only —
 * the target must exist and have source "appeal" (escalations and ban reviews
 * are managed under /api/moderation/review/[id]). Reviewer identity is derived
 * from the verified token, never the request body.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { optionalAuth } from "@/platform/auth/middleware";
import { logger, generateRequestId } from "@/lib/logger";
import {
  claimItem,
  unclaimItem,
  resolveItem,
} from "@/platform/moderation/review-service";
import { getReviewQueueStore } from "@/platform/moderation/review-store";
import type { ReviewDecision } from "@/platform/moderation/review-types";
import type { ModerationAction } from "@/platform/moderation/types";

const MODERATE_PERMISSION = "can_moderate";

function statusForError(error: string): number {
  if (error.includes("not found")) return 404;
  if (error.includes("required")) return 400;
  return 409;
}

async function resolveReviewerId(request: NextRequest): Promise<string> {
  const { user } = await optionalAuth(request);
  return user?.sub ?? "dev-admin";
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const denied = await adminGuard(request, MODERATE_PERMISSION);
  if (denied) return denied;

  const requestId = generateRequestId();
  const { id } = await context.params;
  const reviewerId = await resolveReviewerId(request);

  let body: {
    action?: string;
    decision?: ReviewDecision;
    reviewerNotes?: string;
    modifiedAction?: ModerationAction;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    // Scope guard: this endpoint only operates on appeal items.
    const item = await getReviewQueueStore().getById(id);
    if (!item || item.source !== "appeal") {
      return NextResponse.json({ error: "Appeal not found" }, { status: 404 });
    }

    switch (body.action) {
      case "claim": {
        const result = await claimItem(id, reviewerId);
        if (!result.success) {
          return NextResponse.json(
            { error: result.error },
            { status: statusForError(result.error ?? "") }
          );
        }
        return NextResponse.json({ item: result.item });
      }
      case "unclaim": {
        const result = await unclaimItem(id, reviewerId);
        if (!result.success) {
          return NextResponse.json(
            { error: result.error },
            { status: statusForError(result.error ?? "") }
          );
        }
        return NextResponse.json({ item: result.item });
      }
      case "resolve": {
        if (!body.decision || !body.reviewerNotes) {
          return NextResponse.json(
            { error: "decision and reviewerNotes are required to resolve" },
            { status: 400 }
          );
        }
        const result = await resolveItem({
          itemId: id,
          reviewerId,
          decision: body.decision,
          reviewerNotes: body.reviewerNotes,
          modifiedAction: body.modifiedAction,
        });
        if (!result.success) {
          return NextResponse.json(
            { error: result.error },
            { status: statusForError(result.error ?? "") }
          );
        }
        return NextResponse.json({ item: result.item });
      }
      default:
        return NextResponse.json(
          { error: "action must be one of: claim, unclaim, resolve" },
          { status: 400 }
        );
    }
  } catch (err) {
    logger.error("Appeal action error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      reviewItemId: id,
      action: body.action,
      route: "api/moderation/appeals/[id]",
    });
    return NextResponse.json({ error: "Failed to update appeal" }, { status: 500 });
  }
}
