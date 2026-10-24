/**
 * app/api/operator/readiness/route.ts — is the deployment set up to keep tenants apart?
 * (operators only, ADR-053). Read-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { checkTenancyReadiness } from "@/platform/tenancy/readiness";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  try {
    return NextResponse.json(await checkTenancyReadiness());
  } catch (error) {
    return internalError(error, { request, context: "Tenancy readiness check failed" });
  }
});
