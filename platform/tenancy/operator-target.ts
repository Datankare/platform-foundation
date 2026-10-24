/**
 * platform/tenancy/operator-target.ts — an operator acting on one tenant's settings (ADR-053 D5, D7)
 *
 * An operator works from their own tenant; per-tenant settings — and the approvals and holds
 * those changes create — belong to the tenant they are for. inTargetTenant runs the work in the
 * target tenant's scope (its transactions, its row-level security, its audit log, its caches),
 * so everything the config page does for a tenant's own administrators an operator can do for
 * any tenant, through the same governed code — never by reaching past it.
 *
 * Only in a shared deployment (a single one's settings are its platform defaults, on the
 * Platform Config page); only for a tenant that exists and is not deleted.
 *
 * @module platform/tenancy
 */

import type { NextRequest } from "next/server";
import { apiError, internalError } from "@/platform/errors";
import { getTenantDirectory } from "./directory";
import { isTenantId, peekTenant, runWithTenant } from "./context";

export async function inTargetTenant(
  tenantId: string,
  request: NextRequest,
  work: () => Promise<Response>
): Promise<Response> {
  if (peekTenant()?.mode !== "shared") {
    return apiError("tenant.not_shared", { request });
  }
  if (!isTenantId(tenantId)) return apiError("tenant.not_found", { request });
  let status: string | undefined;
  try {
    status = (await getTenantDirectory().getTenant(tenantId))?.status;
  } catch (error) {
    return internalError(error, { request, context: "Tenant lookup failed" });
  }
  if (status === undefined) return apiError("tenant.not_found", { request });
  if (status === "deleted") return apiError("tenant.not_active", { request });
  return runWithTenant({ tenantId, mode: "shared" }, work);
}
