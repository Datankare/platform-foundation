/**
 * app/api/admin/agents/suspend/route.ts — the agent kill switch for the current tenant, in every
 * deployment mode (review 12 L7)
 *
 * POST { reason } — suspends every agent registered for the current tenant at once, without a
 * second admin (platform/admin/agent-kill-switch.ts): a strict reduction of power, compare-and-
 * set, audited (attempted, then succeeded or failed) and alerted; pending holds on the registry
 * are withdrawn and every instance's cached registry dropped. Answers { suspended, withdrawn }.
 *
 * The operators' route (POST /api/operator/tenants/[id]/agents/suspend) needs platform_operate,
 * which a single-tenant deployment's administrators may not hold: this one needs the registry's
 * own tier permission, config_manage_safety — what approving a held change to it needs. In a
 * single-tenant deployment it suspends the deployment's agents (the platform default); in a
 * shared one, the tenant's own registry, where the deployment lets the caller change it
 * (config-scope.ts) — otherwise it is refused as the config write would be.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { AuditWriteError } from "@/platform/auth/audit";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { suspendAllAgents } from "@/platform/admin/agent-kill-switch";
import { tenantRoute } from "@/platform/tenancy/route";
import { logger } from "@/lib/logger";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const guard = await requireAdmin(request, "config_manage_safety");
  if (guard.error) return guard.error;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const { reason } = read.body as Record<string, unknown>;
  if (typeof reason !== "string" || reason.trim() === "") {
    return apiError("request.missing_fields", {
      params: { fields: ["reason"] },
      request,
    });
  }
  try {
    const outcome = await suspendAllAgents(guard.admin, reason.trim().slice(0, 500));
    if (!outcome.ok) {
      logger.warn("Agent kill switch refused", {
        error: outcome.error,
        route: "api/admin/agents/suspend",
      });
      return apiError("admin.kill_switch_failed", { request });
    }
    return NextResponse.json({
      suspended: outcome.suspended,
      withdrawn: outcome.withdrawn ?? [],
      // Nothing was active: the invalidation was published again, or not (review 13 L2).
      ...(outcome.republished !== undefined ? { republished: outcome.republished } : {}),
    });
  } catch (error) {
    if (error instanceof AuditWriteError) {
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    }
    return internalError(error, { request, context: "Agent suspension failed" });
  }
});
