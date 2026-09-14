/**
 * app/api/admin/approvals/route.ts — the unified pending-approvals read surface (ADR-040, 040a).
 *
 * GET — list every live hold (runtime dual-control + config-approval two-person), each with the
 * permission required to clear it. Read-only; approve/reject is 040b (POST /[id]).
 *
 * Gated on can_access_admin: any admin may SEE the queue (transparency / manageability);
 * clearing a hold still requires the per-change permission, enforced in 040b.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "can_access_admin");
  if (denied) return denied;

  const requestId = generateRequestId();
  try {
    const approvals = await listPendingApprovals();
    return NextResponse.json({ approvals, requestId });
  } catch (err) {
    logger.error(
      `pending-approvals list failed: ${err instanceof Error ? err.message : String(err)} (req ${requestId})`
    );
    return NextResponse.json(
      { error: "Failed to list pending approvals", requestId },
      { status: 500 }
    );
  }
}
