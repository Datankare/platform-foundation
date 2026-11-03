/**
 * app/api/admin/approvals/route.ts — the unified pending-approvals read surface (ADR-040, 040a).
 *
 * GET — list every live hold (runtime dual-control + config-approval two-person), each with the
 * permission required to clear it. Read-only; approve/reject is 040b (POST /[id]).
 *
 * Gated on can_access_admin: any admin may SEE the queue (transparency / manageability);
 * clearing a hold still requires the per-change permission, enforced in 040b. A hold's summary
 * (the account it acts on — an address among it) goes only to an admin holding that permission
 * (TASK-194 round 2, N2).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import { apiError } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;

  const requestId = generateRequestId();
  try {
    // Each hold's summary only to an admin who could decide it (TASK-194 round 2, N2).
    const approvals = await listPendingApprovals([COMMAND_BAR_HOLDS], verified.admin);
    return NextResponse.json({ approvals, requestId });
  } catch (err) {
    logger.error(
      `pending-approvals list failed: ${err instanceof Error ? err.message : String(err)} (req ${requestId})`
    );
    return apiError("internal.error", { params: { requestId }, request });
  }
});
