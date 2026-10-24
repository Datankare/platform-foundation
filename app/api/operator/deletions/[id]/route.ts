/**
 * app/api/operator/deletions/[id]/route.ts — decide a tenant deletion request (operators only,
 * ADR-053 D7). Approval must come from an operator other than the requester; the requester may
 * reject (withdraw) their own.
 *
 * POST { decision: "approve" | "reject", note? }
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { decideTenantDeletion } from "@/platform/tenancy/admin";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const { decision, note } = read.body as Record<string, unknown>;
  if (decision !== "approve" && decision !== "reject") {
    return apiError("request.missing_fields", {
      params: { fields: ["decision"] },
      request,
    });
  }
  if (note !== undefined && typeof note !== "string") {
    return apiError("request.invalid_body", { request });
  }
  try {
    return operatorResponse(
      await decideTenantDeletion(
        operatorOf(guard.admin),
        id,
        decision === "approve",
        note ?? ""
      ),
      request
    );
  } catch (error) {
    return internalError(error, { request, context: "Tenant deletion decision failed" });
  }
});
