/**
 * app/api/operator/tenants/[id]/agents/suspend/route.ts — the agent kill switch (operators only,
 * review 11 M-2)
 *
 * POST { reason } — suspends every agent registered for the tenant at once, without a second
 * admin (platform/admin/agent-kill-switch.ts): a strict reduction of power, compare-and-set,
 * audited and alerted. Answers { suspended: [agent ids] }. Reactivation is held as before.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { AuditWriteError } from "@/platform/auth/audit";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { suspendAllAgents } from "@/platform/admin/agent-kill-switch";
import { inTargetTenant } from "@/platform/tenancy/operator-target";
import { tenantRoute } from "@/platform/tenancy/route";
import { logger } from "@/lib/logger";

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
  if (typeof reason !== "string" || reason.trim() === "") {
    return apiError("request.missing_fields", {
      params: { fields: ["reason"] },
      request,
    });
  }
  return inTargetTenant(id, request, async () => {
    try {
      const outcome = await suspendAllAgents(guard.admin, reason.trim());
      if (!outcome.ok) {
        logger.warn("Agent kill switch refused", {
          tenantId: id,
          error: outcome.error,
          route: "api/operator/tenants/[id]/agents/suspend",
        });
        return apiError("admin.kill_switch_failed", { request });
      }
      return NextResponse.json({
        suspended: outcome.suspended,
        ...(outcome.republished !== undefined
          ? { republished: outcome.republished }
          : {}),
      });
    } catch (error) {
      if (error instanceof AuditWriteError) {
        return apiError("service.unavailable", { params: { service: "audit" }, request });
      }
      return internalError(error, { request, context: "Agent suspension failed" });
    }
  });
});
