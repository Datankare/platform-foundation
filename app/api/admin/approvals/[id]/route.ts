/**
 * app/api/admin/approvals/[id]/route.ts — the approval decision surface (ADR-040, 040b).
 *
 * POST — approve or reject a held change in the admin's tenant: platform/admin/approval-decision.ts.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { decideApproval } from "@/platform/admin/approval-decision";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { id } = await context.params;
  return decideApproval(request, verified.admin, id, [COMMAND_BAR_HOLDS]);
});
