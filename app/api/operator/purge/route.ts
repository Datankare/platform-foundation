/**
 * app/api/operator/purge/route.ts — purge every deleted tenant whose purge time has passed
 * (operators only, ADR-053 D7). The tenancy.purge-due job (ADR-056 D3) runs the same function
 * on its schedule; this is an operator's "purge now".
 *
 * POST → { result: [{ tenantId, rows }] }
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { purgeDueTenants } from "@/platform/tenancy/admin";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  try {
    return operatorResponse(await purgeDueTenants(operatorOf(guard.admin)), request);
  } catch (error) {
    return internalError(error, { request, context: "Tenant purge failed" });
  }
});
