/**
 * app/api/operator/tenants/[id]/domains/route.ts — a tenant's addresses (operators only,
 * ADR-053 D2/D7)
 *
 * POST    { host }   map the host to the tenant (a host serves one tenant)
 * DELETE  ?host=…    unmap it
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { addTenantDomain, removeTenantDomain } from "@/platform/tenancy/admin";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

type Ctx = { params: Promise<{ id: string }> };

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: Ctx
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const { host } = read.body as Record<string, unknown>;
  if (typeof host !== "string") {
    return apiError("request.missing_fields", { params: { fields: ["host"] }, request });
  }
  try {
    return operatorResponse(
      await addTenantDomain(operatorOf(guard.admin), id, host),
      request,
      201
    );
  } catch (error) {
    return internalError(error, { request, context: "Adding a tenant address failed" });
  }
});

export const DELETE = tenantRoute(async function DELETE(
  request: NextRequest,
  { params }: Ctx
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const host = request.nextUrl.searchParams.get("host");
  if (!host)
    return apiError("request.missing_fields", { params: { fields: ["host"] }, request });
  try {
    return operatorResponse(
      await removeTenantDomain(operatorOf(guard.admin), id, host),
      request
    );
  } catch (error) {
    return internalError(error, { request, context: "Removing a tenant address failed" });
  }
});
