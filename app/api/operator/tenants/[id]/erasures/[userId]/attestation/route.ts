/**
 * app/api/operator/tenants/[id]/erasures/[userId]/attestation/route.ts — two operators close an
 * external erasure the system cannot verify (operators only; TASK-193 review round 1,
 * platform/gdpr/erasure-attestation.ts)
 *
 * POST { reason, note, store? }            ask (reason: pool_decommissioned | deleted_in_old_pool
 *                                          | identity_never_existed; note 3–500 characters)
 * POST { decision: "approve" | "reject", note?, store? }
 *                                          decide — approval by a different operator
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import {
  apiError,
  internalError,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import {
  decideErasureAttestation,
  requestErasureAttestation,
} from "@/platform/gdpr/erasure-attestation";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";
import type { OperatorResult } from "@/platform/tenancy/admin";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const ATTESTATION_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    decision: { type: "string" },
    reason: { type: "string" },
    note: { type: "string" },
    store: { type: "string" },
  },
};

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    result: {
      type: "object",
      properties: {
        attempts: {
          type: "number",
        },
        attestationRequest: {
          type: "object",
          properties: {
            at: {
              type: "string",
            },
            by: {
              type: "string",
            },
            expiresAt: {
              type: "string",
            },
            reason: {
              type: "string",
            },
          },
        },
        attested: {
          type: "object",
          properties: {
            at: {
              type: "string",
            },
            by: {
              type: "string",
            },
            reason: {
              type: "string",
            },
            requestedBy: {
              type: "string",
            },
          },
        },
        doneAt: {
          type: "string",
        },
        poolUnverified: {
          type: "boolean",
        },
        retryAt: {
          type: "string",
        },
      },
    },
  },
};

/**
 * The store's step as the operator is answered (TASK-215, A-13): the recorded step without the
 * provider's own error text, as the erasures list shows it (platform/gdpr/erasure-status.ts) — a
 * provider's message can name the account or its pool, and the operator acts on the step's state
 * (its attempts, its retry, the open request), not on that text.
 */
function stepAnswer<T extends { readonly error?: string }>(
  result: OperatorResult<T>
): OperatorResult<Omit<T, "error">> {
  if (!result.ok) return result;
  return {
    ...result,
    value: Object.fromEntries(
      Object.entries(result.value).filter(([key]) => key !== "error")
    ) as Omit<T, "error">,
  };
}

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id, userId } = await params;
  const read = await readJsonBody(request, ATTESTATION_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const { decision, reason, note, store } = read.body as Record<string, unknown>;
  if (
    (note !== undefined && typeof note !== "string") ||
    (store !== undefined && typeof store !== "string")
  ) {
    return apiError("request.invalid_body", { request });
  }
  const target = { tenantId: id, userId, ...(store ? { store } : {}) };
  try {
    if (decision === undefined) {
      if (typeof reason !== "string" || typeof note !== "string") {
        return apiError("request.missing_fields", {
          params: { fields: ["reason", "note"] },
          request,
        });
      }
      return operatorResponse(
        stepAnswer(
          await requestErasureAttestation(operatorOf(guard.admin), target, reason, note)
        ),
        request,
        201
      );
    }
    if (decision !== "approve" && decision !== "reject") {
      return apiError("request.missing_fields", {
        params: { fields: ["decision"] },
        request,
      });
    }
    return operatorResponse(
      stepAnswer(
        await decideErasureAttestation(
          operatorOf(guard.admin),
          target,
          decision === "approve",
          note ?? ""
        )
      ),
      request
    );
  } catch (error) {
    return internalError(error, { request, context: "Erasure attestation failed" });
  }
}, POST_RESPONSE);
