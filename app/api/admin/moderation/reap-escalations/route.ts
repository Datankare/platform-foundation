/**
 * app/api/admin/moderation/reap-escalations/route.ts — Escalation SLA reaper (ADR-041)
 *
 * POST — sweep over-SLA escalations and apply the configured remedial action
 * (block by default; escalate_higher raises priority). Idempotent.
 *
 * ADR-041 (option A). RBAC (F6): gated on "can_moderate". P10: human-oversight /
 * safety surface. P11: failures return structured JSON rather than throwing. The
 * external scheduler (Vercel Cron or a scheduled workflow) posts here on an
 * interval — wired separately; the route is invocable and testable on its own.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import { reapOverdueEscalations } from "@/platform/moderation/review-service";

const MODERATE_PERMISSION = "can_moderate";

export async function POST(request: NextRequest) {
  const denied = await adminGuard(request, MODERATE_PERMISSION);
  if (denied) return denied;

  const requestId = generateRequestId();
  try {
    const result = await reapOverdueEscalations();
    logger.info(
      `escalation-reaper: scanned=${result.scanned} blocked=${result.blocked} ` +
        `escalatedHigher=${result.escalatedHigher} slaHours=${result.slaHours} (req ${requestId})`
    );
    return NextResponse.json({ ...result, requestId });
  } catch (err) {
    logger.error(
      `escalation-reaper failed: ${err instanceof Error ? err.message : String(err)} (req ${requestId})`
    );
    return NextResponse.json(
      { error: "Escalation reaper failed", requestId },
      { status: 500 }
    );
  }
}
