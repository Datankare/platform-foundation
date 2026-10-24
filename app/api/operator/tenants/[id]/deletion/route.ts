/**
 * app/api/operator/tenants/[id]/deletion/route.ts — ask for a tenant's deletion (operators only,
 * ADR-053 D7). A different operator decides it (POST /api/operator/deletions/[id]).
 *
 * POST { reason }
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { requestTenantDeletion } from "@/platform/tenancy/admin";
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
  const { reason } = read.body as Record<string, unknown>;
  if (typeof reason !== "string") {
    return apiError("request.missing_fields", {
      params: { fields: ["reason"] },
      request,
    });
  }
  try {
    return operatorResponse(
      await requestTenantDeletion(operatorOf(guard.admin), id, reason),
      request,
      202
    );
  } catch (error) {
    return internalError(error, { request, context: "Tenant deletion request failed" });
  }
});
