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
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import {
  decideErasureAttestation,
  requestErasureAttestation,
} from "@/platform/gdpr/erasure-attestation";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id, userId } = await params;
  const read = await readJsonObject(request);
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
        await requestErasureAttestation(operatorOf(guard.admin), target, reason, note),
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
      await decideErasureAttestation(
        operatorOf(guard.admin),
        target,
        decision === "approve",
        note ?? ""
      ),
      request
    );
  } catch (error) {
    return internalError(error, { request, context: "Erasure attestation failed" });
  }
});
