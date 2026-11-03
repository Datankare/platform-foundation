/**
 * app/api/operator/tenants/[id]/approvals/[approvalId]/route.ts — decide one of a tenant's held
 * changes (operators only, ADR-040, ADR-053 D7)
 *
 * POST body:
 *
 *     { decision: "approve" | "reject" | "mark_executed" | "reapprove" | "withdraw",
 *       source, note? }
 *
 * The same decision as /api/admin/approvals/[id] (platform/admin/approval-decision.ts), in that
 * tenant, under the same rules: the decider must hold the permission the change needs, must not be
 * its requester, must not be the account the held action acts on (A3), and — to approve it, approve
 * it again or mark it executed — must satisfy the change's own rules (approverRuleRefusal, C-2).
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { decideApproval } from "@/platform/admin/approval-decision";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import { inTargetTenant } from "@/platform/tenancy/operator-target";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; approvalId: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id, approvalId } = await params;
  return inTargetTenant(id, request, () =>
    decideApproval(request, guard.admin, approvalId, [COMMAND_BAR_HOLDS])
  );
});
