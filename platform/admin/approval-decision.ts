/**
 * platform/admin/approval-decision.ts — deciding one held change (ADR-040, 040b)
 *
 * The decision behind POST /api/admin/approvals/[id], shared by the operators' decision on a
 * tenant's held change (POST /api/operator/tenants/[id]/approvals/[approvalId], which runs it in
 * that tenant). Approve or reject a held change (runtime dual-control or config-approval). The
 * rule, server-side and never trusted from the client: the decider must independently hold the
 * permission required to make the change AND must not be the requester. super_admin holds every
 * permission, so it can break-glass approve.
 *
 * Identity (audit X-8, X-10): the decider is the verified admin's users.id — the id requesters are
 * recorded under — so "not the requester" compares like with like. A runtime hold's requester is
 * the human the agent acted for (onBehalfOf), not the agent. An approved config change is applied
 * here, through the validated, history-recording write — or, for a "reset" approval, the tenant's
 * own value is removed (ADR-053 D5).
 *
 * @module platform/admin
 */

import { NextRequest, NextResponse } from "next/server";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { clearTenantConfig, setConfigWithHistory } from "@/platform/auth/platform-config";
import { audited, AuditWriteError } from "@/platform/auth/audit";
import { logger, generateRequestId } from "@/lib/logger";
import { getProposalStore } from "@/platform/agents/proposal-store";
import {
  approveHeldAction,
  principalOf,
  rejectHeldAction,
} from "@/platform/agents/gating";
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
import { resumeApprovedConfigChange } from "@/platform/admin/config-handlers";
import { approvedChangeTarget, isOperator } from "@/platform/admin/config-scope";

interface DecisionBody {
  decision?: string;
  source?: string;
  note?: string;
}

/** Decide hold `id` as `admin`, in the current tenant; the HTTP response. */
export async function decideApproval(
  request: NextRequest,
  admin: VerifiedAdmin,
  id: string
): Promise<Response> {
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
  // Everyone who could be the hold's requester: a decider who is any of them is not independent.
  let requesters: string[];
  let requiredPermission: string;
  if (source === "runtime") {
    const proposal = await getProposalStore().getById(id);
    if (!proposal) {
      return apiError("approvals.hold_not_found", { request });
    }
    // Recorded as the attested owner (principalOf), never a bare claim. Independence is checked
    // against every identity the hold could stand for — the claim, the attestation and the
    // actor — so a disagreeing claim cannot let the real owner approve their own agent.
    requester = principalOf(proposal.actor) ?? proposal.actor.actorId;
    requesters = [
      proposal.actor.actorId,
      proposal.actor.onBehalfOf,
      proposal.actor.delegation?.onBehalfOf,
    ].filter((x): x is string => typeof x === "string" && x.length > 0);
    requiredPermission = await requiredPermissionForKey(
      proposalConfigKey(proposal.payload)
    );
  } else {
    const record = await getApproval(id);
    if (!record) {
      return apiError("approvals.hold_not_found", { request });
    }
    requester = record.requestedBy ?? null;
    requesters = requester ? [requester] : [];
    requiredPermission = await requiredPermissionForKey(record.configKey);
    // ADR-053 D5: a shared deployment's platform default is an operator's to approve.
    if (
      decision === "approve" &&
      !approvedChangeTarget(isOperator(admin), record.scope).ok
    ) {
      return apiError("admin.config_scope_refused", {
        params: { key: record.configKey },
        request,
      });
    }
  }

  // ADR-040 enforcement, server-side: independent + authorized.
  // Holds recorded before Sprint 7X may name the requester by identity-provider subject.
  if (
    decision === "approve" &&
    requesters.some((r) => r === admin.userId || r === admin.sub)
  ) {
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
          // A held config change is applied now, on its approval (nothing else resumes it) — or,
          // for a safety key under two-person approval, goes on to wait for that approval.
          let resumed: { applied: boolean; approval?: unknown } | undefined;
          if (outcome.kind === "approved") {
            const applied = await resumeApprovedConfigChange(id);
            const data = (applied?.data ?? {}) as {
              applied?: boolean;
              requiresApproval?: boolean;
              approval?: unknown;
              error?: string;
            };
            if (applied?.success && data.applied) resumed = { applied: true };
            else if (applied?.success && data.requiresApproval)
              resumed = { applied: false, approval: data.approval };
            if (applied && !resumed) {
              const error = applied.error ?? data.error ?? "the change was not applied";
              logger.error("Approved held change could not be applied", {
                requestId,
                proposalId: id,
                error,
                route: "platform/admin/approval-decision",
              });
              return {
                success: false,
                error: `Approved but not applied: ${error}`,
                response: apiError("service.unavailable", {
                  params: { service: "config" },
                  request,
                }),
              };
            }
          }
          if (outcome.kind !== "approved") {
            // Already decided, or stale: nothing was approved — the record says so (PF v5.1.0).
            return {
              success: false,
              error: `approval did not commit (${outcome.kind})`,
              response: apiError("approvals.decision_conflict", { request }),
            };
          }
          return {
            success: true,
            response: NextResponse.json({
              decision,
              source,
              outcome: outcome.kind,
              ...(resumed ? { applied: resumed.applied } : {}),
              ...(resumed?.approval ? { pendingApproval: resumed.approval } : {}),
              requestId,
            }),
          };
        }
        const rejected = await rejectHeldAction({ proposalId: id, decidedBy, note });
        if (!rejected) {
          // An approval was recorded first: this is no rejection (PF v5.1.0, register PR-7).
          return {
            success: false,
            error: "rejection did not commit (already decided)",
            response: apiError("approvals.decision_conflict", { request }),
          };
        }
        return {
          success: true,
          response: NextResponse.json({ decision, source, requestId }),
        };
      }
      // An approved change is applied in the same outcome; one that cannot be applied is
      // reopened, never left approved and unapplied (release review).
      const result =
        decision === "approve"
          ? await approveAndApply(id, decidedBy, note ?? "", (record) => {
              const target = approvedChangeTarget(isOperator(admin), record.scope);
              if (!target.ok)
                return Promise.resolve({ success: false, error: target.reason });
              if (record.action === "reset") {
                return clearTenantConfig(
                  record.configKey,
                  decidedBy,
                  `Approved: ${record.changeComment}`,
                  target.target.operator
                );
              }
              return setConfigWithHistory(
                record.configKey,
                record.proposedValue,
                decidedBy,
                `Approved: ${record.changeComment}`,
                "config_agent",
                undefined,
                target.target
              );
            })
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
