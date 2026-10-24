/**
 * app/api/operator/tenants/[id]/admins/route.ts — make a tenant user its administrator
 * (operators only, ADR-053 D7): how a new tenant gets its first admin.
 *
 * POST { email }
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { makeTenantAdmin } from "@/platform/tenancy/admin";
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
  const { email } = read.body as Record<string, unknown>;
  if (typeof email !== "string") {
    return apiError("request.missing_fields", { params: { fields: ["email"] }, request });
  }
  try {
    return operatorResponse(
      await makeTenantAdmin(operatorOf(guard.admin), id, email),
      request
    );
  } catch (error) {
    return internalError(error, {
      request,
      context: "Granting a tenant administrator failed",
    });
  }
});
