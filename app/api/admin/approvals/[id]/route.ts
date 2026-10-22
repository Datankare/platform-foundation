/**
 * app/api/admin/approvals/[id]/route.ts — the approval decision surface (ADR-040, 040b).
 *
 * POST — approve or reject a held change (runtime dual-control or config-approval), dispatching
 * to gating or config-approval. Enforces ADR-040's rule server-side, never trusted from the
 * client: the decider must independently hold the permission required to make the change AND
 * must not be the requester. super_admin holds every permission, so it can break-glass approve.
 *
 * Identity (audit X-8, X-10): the decider is the verified admin's users.id — the id requesters are
 * recorded under — so "not the requester" compares like with like. A runtime hold's requester is
 * the human the agent acted for (onBehalfOf), not the agent. An approved config change is applied
 * here, through the validated, history-recording write; previously it was approved and dropped.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { holds } from "@/platform/auth/role-governance";
import { setConfigWithHistory } from "@/platform/auth/platform-config";
import { audited, AuditWriteError } from "@/platform/auth/audit";
import { logger, generateRequestId } from "@/lib/logger";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { approveHeldAction, rejectHeldAction } from "@/platform/agents/gating";
import {
  getApproval,
  approveAndApply,
  rejectChange,
} from "@/platform/admin/config-approval";
import {
  requiredPermissionForKey,
  proposalConfigKey,
} from "@/platform/admin/pending-approvals";
import { apiError, errorFromResult, readJsonObject } from "@/platform/errors";

interface DecisionBody {
  decision?: string;
  source?: string;
  note?: string;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const { id } = await context.params;
  const requestId = generateRequestId();
  const decidedBy = admin.userId;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as DecisionBody;

  const { decision, source, note } = body;
  if (decision !== "approve" && decision !== "reject") {
    return apiError("request.invalid_value", {
      params: { field: "decision", allowed: ["approve", "reject"] },
      request,
    });
  }
  if (source !== "runtime" && source !== "config-approval") {
    return apiError("request.invalid_value", {
      params: { field: "source", allowed: ["runtime", "config-approval"] },
      request,
    });
  }

  // Resolve the hold: who requested it, and the permission required to clear it.
  let requester: string | null;
  let requiredPermission: string;
  if (source === "runtime") {
    const proposal = await getProposalStore().getById(id);
    if (!proposal) {
      return apiError("approvals.hold_not_found", { request });
    }
    requester = proposal.actor.onBehalfOf ?? proposal.actor.actorId;
    requiredPermission = await requiredPermissionForKey(
      proposalConfigKey(proposal.payload)
    );
  } else {
    const record = await getApproval(id);
    if (!record) {
      return apiError("approvals.hold_not_found", { request });
    }
    requester = record.requestedBy ?? null;
    requiredPermission = await requiredPermissionForKey(record.configKey);
  }

  // ADR-040 enforcement, server-side: independent + authorized.
  // Holds recorded before Sprint 7X may name the requester by identity-provider subject.
  if (decision === "approve" && (requester === admin.userId || requester === admin.sub)) {
    return apiError("approvals.self_approval", { request });
  }
  if (!holds(admin, requiredPermission)) {
    return apiError("approvals.permission_required", {
      params: { permission: requiredPermission },
      request,
    });
  }

  // Every decision is recorded before it takes effect, naming the decider and the requester
  // (release review, Sprint 7X: decisions left no audit record).
  const entry = {
    action: "admin_action" as const,
    actorId: decidedBy,
    details: {
      type: "approval_decision",
      holdId: id,
      source,
      decision,
      requester,
      requiredPermission,
    },
  };

  try {
    const done = await audited(entry, async () => {
      if (source === "runtime") {
        if (decision === "approve") {
          const outcome = await approveHeldAction({ proposalId: id, decidedBy, note });
          return {
            success: true,
            response: NextResponse.json({
              decision,
              source,
              outcome: outcome.kind,
              requestId,
            }),
          };
        }
        await rejectHeldAction({ proposalId: id, decidedBy, note });
        return {
          success: true,
          response: NextResponse.json({ decision, source, requestId }),
        };
      }
      // An approved change is applied in the same outcome; one that cannot be applied is
      // reopened, never left approved and unapplied (release review).
      const result =
        decision === "approve"
          ? await approveAndApply(id, decidedBy, note ?? "", (record) =>
              setConfigWithHistory(
                record.configKey,
                record.proposedValue,
                decidedBy,
                `Approved: ${record.changeComment}`,
                "config_agent"
              )
            )
          : await rejectChange(id, decidedBy, note ?? "");
      if (!result.success) {
        logger.error("Approval decision failed", {
          requestId,
          approvalId: id,
          error: result.error,
          route: "api/admin/approvals/[id]",
        });
        return {
          success: false,
          error: result.error,
          response: errorFromResult(result, {
            request,
            context: "Approval decision failed",
          }),
        };
      }
      return {
        success: true,
        response: NextResponse.json({ decision, source, requestId }),
      };
    });
    return done.response;
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    }
    logger.error(
      `approval decision failed: ${err instanceof Error ? err.message : String(err)} (req ${requestId})`
    );
    return apiError("internal.error", { params: { requestId }, request });
  }
}
