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
import {
  apiError,
  errorFromResult,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";
import { type ResponseSchema, SHOWN, stored } from "@/platform/errors/response-schema";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const DECISION_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    action: { type: "string" },
    decision: { type: "string" },
    reviewerNotes: { type: "string" },
    modifiedAction: { type: "string" },
  },
};

const MODERATE_PERMISSION = "can_moderate";

const PATCH_RESPONSE: ResponseSchema = {
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

  // The reviewer is the verified caller (audit X-8): one named in the body is the server's to set.
  const read = await readJsonBody(request, DECISION_BODY_SCHEMA, {
    notAccepted: ["reviewerId"],
  });
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
}, PATCH_RESPONSE);
