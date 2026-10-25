/**
 * app/api/operator/tenants/[id]/approvals/route.ts — one tenant's held changes (operators only,
 * ADR-040, ADR-053 D7)
 *
 * GET — every live hold of that tenant (runtime dual-control and two-person config approvals),
 * each with the permission required to clear it: the changes an operator's per-tenant settings
 * (../config) are waiting on. Decided with POST ./[approvalId].
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import { internalError } from "@/platform/errors";
import { inTargetTenant } from "@/platform/tenancy/operator-target";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  return inTargetTenant(id, request, async () => {
    try {
      return NextResponse.json({
        tenantId: id,
        approvals: await listPendingApprovals([COMMAND_BAR_HOLDS]),
      });
    } catch (error) {
      return internalError(error, { request, context: "Tenant approvals read failed" });
    }
  });
});
