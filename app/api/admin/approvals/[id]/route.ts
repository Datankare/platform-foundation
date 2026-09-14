/**
 * app/api/admin/approvals/[id]/route.ts — the approval decision surface (ADR-040, 040b).
 *
 * POST — approve or reject a held change (runtime dual-control or config-approval), dispatching
 * to gating or config-approval. Enforces ADR-040's rule server-side, never trusted from the
 * client: the decider must independently hold the permission required to make the change AND
 * must not be the requester. super_admin holds every permission, so it can break-glass approve.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { optionalAuth } from "@/platform/auth/middleware";
import { hasPermission } from "@/platform/auth/permissions";
import { logger, generateRequestId } from "@/lib/logger";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { approveHeldAction, rejectHeldAction } from "@/platform/agents/gating";
import {
  getApproval,
  approveChange,
  rejectChange,
} from "@/platform/admin/config-approval";
import {
  requiredPermissionForKey,
  proposalConfigKey,
} from "@/platform/admin/pending-approvals";

interface DecisionBody {
  decision?: string;
  source?: string;
  note?: string;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const denied = await adminGuard(request, "can_access_admin");
  if (denied) return denied;

  const { id } = await context.params;
  const requestId = generateRequestId();

  const { user } = await optionalAuth(request);
  const decidedBy = user?.sub;
  if (!decidedBy) {
    return NextResponse.json({ error: "Unauthenticated", requestId }, { status: 401 });
  }

  let body: DecisionBody;
  try {
    body = (await request.json()) as DecisionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON", requestId }, { status: 400 });
  }

  const { decision, source, note } = body;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: "decision must be 'approve' or 'reject'", requestId },
      { status: 400 }
    );
  }
  if (source !== "runtime" && source !== "config-approval") {
    return NextResponse.json(
      { error: "source must be 'runtime' or 'config-approval'", requestId },
      { status: 400 }
    );
  }

  // Resolve the hold: who requested it, and the permission required to clear it.
  let requester: string;
  let requiredPermission: string;
  if (source === "runtime") {
    const proposal = await getProposalStore().getById(id);
    if (!proposal) {
      return NextResponse.json({ error: "Hold not found", requestId }, { status: 404 });
    }
    requester = proposal.actor.actorId;
    requiredPermission = await requiredPermissionForKey(
      proposalConfigKey(proposal.payload)
    );
  } else {
    const record = await getApproval(id);
    if (!record) {
      return NextResponse.json({ error: "Hold not found", requestId }, { status: 404 });
    }
    requester = record.requestedBy ?? "";
    requiredPermission = await requiredPermissionForKey(record.configKey);
  }

  // ADR-040 enforcement, server-side: independent + authorized.
  if (decision === "approve" && decidedBy === requester) {
    return NextResponse.json(
      {
        error: "Self-approval is not permitted; an independent approver must clear this.",
        requestId,
      },
      { status: 409 }
    );
  }
  const authorized = await hasPermission(decidedBy, requiredPermission);
  if (!authorized) {
    return NextResponse.json(
      {
        error: `This change requires the ${requiredPermission} permission to clear.`,
        requestId,
      },
      { status: 403 }
    );
  }

  try {
    if (source === "runtime") {
      if (decision === "approve") {
        const outcome = await approveHeldAction({ proposalId: id, decidedBy, note });
        return NextResponse.json({ decision, source, outcome: outcome.kind, requestId });
      }
      await rejectHeldAction({ proposalId: id, decidedBy, note });
      return NextResponse.json({ decision, source, requestId });
    }
    const result =
      decision === "approve"
        ? await approveChange(id, decidedBy, note ?? "")
        : await rejectChange(id, decidedBy, note ?? "");
    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? "Decision failed", requestId },
        { status: 409 }
      );
    }
    return NextResponse.json({ decision, source, requestId });
  } catch (err) {
    logger.error(
      `approval decision failed: ${err instanceof Error ? err.message : String(err)} (req ${requestId})`
    );
    return NextResponse.json(
      { error: "Failed to record the decision", requestId },
      { status: 500 }
    );
  }
}
