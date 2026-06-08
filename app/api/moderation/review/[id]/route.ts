/**
 * app/api/moderation/review/[id]/route.ts — Review item actions
 *
 * PATCH — claim, unclaim, or resolve a single review item.
 *
 * ADR-024. RBAC (F6): gated on "can_moderate". The reviewer identity is derived
 * from the verified token (optionalAuth) — NEVER from the request body — so
 * claim/resolve ownership cannot be spoofed by a caller. P17: claim is cognition
 * (reversible), resolve is commitment (durable side effects).
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
import type { ReviewDecision } from "@/platform/moderation/review-types";
import type { ModerationAction } from "@/platform/moderation/types";

const MODERATE_PERMISSION = "can_moderate";

/** Map a service error string to an HTTP status. */
function statusForError(error: string): number {
  if (error.includes("not found")) return 404;
  if (error.includes("required")) return 400;
  return 409;
}

/**
 * The acting reviewer's id, taken from the verified token. Falls back to
 * "dev-admin" only when there is no token (ADMIN_DEV_BYPASS local flow), which
 * mirrors getAdminActorId in admin-guard.
 */
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
    logger.error("Review item action error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      reviewItemId: id,
      action: body.action,
      route: "api/moderation/review/[id]",
    });
    return NextResponse.json({ error: "Failed to update review item" }, { status: 500 });
  }
}
