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
 * Runtime holds (audit X-10, B-10, RR-19): each is decided by its authority
 * (platform/admin/hold-authority.ts) — the platform's config tools, and those the calling route
 * passes (PF's command bar). The authority names the permission the decider must hold (the one
 * the change itself needs, not a blanket safety permission) and runs the approved hold at once,
 * once. A hold no authority owns is not this surface's to decide (approvals.hold_not_found, as
 * for one that does not exist — its owner decides it through the app's agent-approval route).
 *
 * An approved hold's run claims the approval (approved -> executing) and ends it: executed when it
 * took effect; approved again when it failed before taking effect (review 10 H2) — the answer is
 * approvals.run_failed, "still approved: approve it again to retry", which is then true. An
 * approved hold whose run failed (review 7 M7) is approved again to retry, or rejected by an
 * authorized admin (the approval is withdrawn, recorded like any decision); once
 * config.approval_expiry_days have passed since its approval it has lapsed — a decision on it
 * answers approvals.expired and withdraws it (platform/admin/hold-expiry.ts).
 *
 * An approved run whose outcome is unknown (review 11 H-1: status indeterminate — it did not end
 * within its lease and left no step) takes only a decision on its outcome: "mark_executed" (the
 * decider verified it took effect; the hold's permission needed) or "reapprove" (verified it did
 * not; a fresh approval, independent of the requester and under the hold's scope rules, run at
 * once, once). "approve" and "reject" on it answer approvals.indeterminate, and the two new
 * decisions on anything else approvals.decision_conflict. Each is recorded (approval_decision).
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
  settleHeldTrajectory,
} from "@/platform/agents/gating";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";
import {
  getApproval,
  approveAndApply,
  rejectChange,
} from "@/platform/admin/config-approval";
import { requiredPermissionForKey } from "@/platform/admin/pending-approvals";
import { apiError, errorFromResult, readJsonObject } from "@/platform/errors";
import {
  authorityFor,
  proposalConfigKey,
  type HoldAuthority,
  type HoldResumeResult,
} from "@/platform/admin/hold-authority";
import type { ProposalRecord } from "@/platform/kernel/types";
import { approvedChangeTarget, isOperator } from "@/platform/admin/config-scope";
import {
  approvalExpiryDays,
  holdLapsed,
  HOLD_EXPIRY_ACTOR,
  lapsedNote,
  undecidedNote,
} from "@/platform/admin/hold-expiry";

interface DecisionBody {
  decision?: string;
  source?: string;
  note?: string;
}

/** Decide hold `id` as `admin`, in the current tenant; the HTTP response. */
export async function decideApproval(
  request: NextRequest,
  admin: VerifiedAdmin,
  id: string,
  authorities: readonly HoldAuthority[] = []
): Promise<Response> {
  const requestId = generateRequestId();
  const decidedBy = admin.userId;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as DecisionBody;

  const { decision, source, note } = body;
  if (
    decision !== "approve" &&
    decision !== "reject" &&
    decision !== "mark_executed" &&
    decision !== "reapprove"
  ) {
    return apiError("request.invalid_value", {
      params: {
        field: "decision",
        allowed: ["approve", "reject", "mark_executed", "reapprove"],
      },
      request,
    });
  }
  // A decision on an approved run whose outcome is unknown (review 11 H-1): only a runtime hold.
  const onUndecided = decision === "mark_executed" || decision === "reapprove";
  if (source !== "runtime" && source !== "config-approval") {
    return apiError("request.invalid_value", {
      params: { field: "source", allowed: ["runtime", "config-approval"] },
      request,
    });
  }
  if (onUndecided && source !== "runtime") {
    return apiError("request.invalid_value", {
      params: { field: "decision", allowed: ["approve", "reject"] },
      request,
    });
  }

  // Resolve the hold: who requested it, and the permission required to clear it.
  let requester: string | null;
  // Everyone who could be the hold's requester: a decider who is any of them is not independent.
  let requesters: string[];
  let requiredPermission: string;
  let held: { proposal: ProposalRecord; authority: HoldAuthority } | undefined;
  if (source === "runtime") {
    const proposal = await getProposalStore().getById(id);
    const authority = proposal ? authorityFor(proposal, authorities) : undefined;
    if (!proposal || !authority) {
      return apiError("approvals.hold_not_found", { request });
    }
    held = { proposal, authority };
    // An undecided run takes only a decision on its outcome, and only it does (review 11 H-1):
    // approving or rejecting it as if it never ran could run its effect a second time.
    if ((proposal.status === "indeterminate") !== onUndecided) {
      return proposal.status === "indeterminate"
        ? apiError("approvals.indeterminate", { request })
        : apiError("approvals.decision_conflict", { request });
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
    requiredPermission = await authority.requiredPermission(proposal);
    // The hold's own scope rule (a config hold: a shared deployment's platform default is an
    // operator's to approve, as for a held config approval — review 10 H1).
    if (
      (decision === "approve" || decision === "reapprove") &&
      authority.approverRefusal
    ) {
      const refused = await authority.approverRefusal(proposal, isOperator(admin));
      if (refused) {
        return apiError("admin.config_scope_refused", {
          params: { key: proposalConfigKey(proposal.payload) ?? proposal.label },
          request,
        });
      }
    }
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

  // ADR-040 enforcement, server-side: independent + authorized. Marking an undecided run
  // executed is a decision on the hold like approving it (review 12 L7): the requester may not
  // declare their own change applied either.
  // Holds recorded before Sprint 7X may name the requester by identity-provider subject.
  if (
    (decision === "approve" ||
      decision === "reapprove" ||
      decision === "mark_executed") &&
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
      ...(held ? { authority: held.authority.name, label: held.proposal.label } : {}),
    },
  };

  // An approval never used, past its period, is withdrawn and decided no further (M7) — and so is
  // a hold never decided (TASK-193, audit B-4: a held role change could be approved a year
  // later). The withdrawal is the system's (the period ran out), recorded before it is made, with
  // the decision that found it lapsed (review 8 L5: it left no audit record).
  if (
    held &&
    (held.proposal.status === "approved" || held.proposal.status === "proposed")
  ) {
    const days = await approvalExpiryDays();
    const undecided = held.proposal.status === "proposed";
    if (holdLapsed(held.proposal, days)) {
      try {
        await audited(
          {
            action: "admin_action",
            agent: HOLD_EXPIRY_ACTOR,
            details: {
              type: "approval_withdrawn",
              reason: "expired",
              holdId: id,
              source,
              label: held.proposal.label,
              ...(undecided
                ? { decision: "undecided", requestedAt: held.proposal.createdAt }
                : {
                    approvedBy: held.proposal.decidedBy ?? null,
                    approvedAt: held.proposal.decidedAt ?? null,
                  }),
              foundBy: decidedBy,
            },
          },
          async () => {
            const withdrawn = undecided
              ? await getProposalStore().decide(
                  id,
                  "rejected",
                  HOLD_EXPIRY_ACTOR,
                  undecidedNote(days)
                )
              : await getProposalStore().withdraw(
                  id,
                  HOLD_EXPIRY_ACTOR,
                  lapsedNote(days)
                );
            // Its trajectory ends with it (TASK-193); best effort, as every settle.
            await Promise.resolve()
              .then(() => settleHeldTrajectory(getTrajectoryStore(), withdrawn))
              .catch(() => undefined);
            return withdrawn
              ? { success: true as const }
              : { success: false as const, error: "already used or decided" };
          }
        );
      } catch (err) {
        if (err instanceof AuditWriteError)
          return apiError("service.unavailable", {
            params: { service: "audit" },
            request,
          });
        throw err;
      }
      return apiError("approvals.expired", { request });
    }
  }

  try {
    const done = await audited(entry, async () => {
      if (source === "runtime") {
        return decideRuntimeHold({
          request,
          id,
          decision,
          note,
          decidedBy,
          requestId,
          held,
        });
      }
      // An approved change is applied in the same outcome; one that cannot be applied is
      // reopened, never left approved and unapplied (release review).
      const result =
        decision === "approve"
          ? await approveAndApply(id, decidedBy, note ?? "", (record) => {
              const target = approvedChangeTarget(isOperator(admin), record.scope);
              if (!target.ok)
                return Promise.resolve({ success: false, error: target.reason });
              // Only onto the value it was requested against (review 12 H2): a change made
              // since — a kill switch, a power reduction — makes it stale, never undone by it.
              const expectPrevious = { value: record.currentValue };
              if (record.action === "reset") {
                // A reset's proposed value is the platform default it inherits, recorded at
                // request time: it applies only while the default is still that (review 13 M1).
                return clearTenantConfig(
                  record.configKey,
                  decidedBy,
                  `Approved: ${record.changeComment}`,
                  target.target.operator,
                  { expectPrevious, expectInherited: { value: record.proposedValue } }
                );
              }
              return setConfigWithHistory(
                record.configKey,
                record.proposedValue,
                decidedBy,
                `Approved: ${record.changeComment}`,
                "config_agent",
                undefined,
                target.target,
                { expectPrevious }
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

/** A decided runtime hold's outcome: the audit outcome and the HTTP response. */
interface DecisionOutcome {
  readonly success: boolean;
  readonly error?: string;
  readonly response: Response;
}

/**
 * Decide runtime hold `id` (its checks — authority, independence, permission, lapse — already
 * made): withdraw, reject, approve and run, approve an undecided run again and run it, or mark an
 * undecided run executed (review 11 H-1).
 */
async function decideRuntimeHold(args: RuntimeDecisionArgs): Promise<DecisionOutcome> {
  try {
    return await decideRuntimeHoldNow(args);
  } finally {
    // Whatever the decision did, the hold's trajectory follows its proposal (TASK-193): the
    // action ran — completed; withdrawn or rejected — failed; approved, its run failed — waiting
    // to be approved again. Before, every decision path but a plain rejection left it open.
    // Best effort: the decision's answer never depends on it — the reaper ends what is left.
    try {
      const now = await getProposalStore()
        .getById(args.id)
        .catch(() => undefined);
      await settleHeldTrajectory(getTrajectoryStore(), now);
    } catch {
      // Logged by nothing: settleHeldTrajectory swallows its own errors; this guards the read.
    }
  }
}

interface RuntimeDecisionArgs {
  readonly request: NextRequest;
  readonly id: string;
  readonly decision: "approve" | "reject" | "mark_executed" | "reapprove";
  readonly note: string | undefined;
  readonly decidedBy: string;
  readonly requestId: string;
  readonly held: { proposal: ProposalRecord; authority: HoldAuthority } | undefined;
}

async function decideRuntimeHoldNow(args: RuntimeDecisionArgs): Promise<DecisionOutcome> {
  const { request, id, decision, note, decidedBy, requestId } = args;
  const source = "runtime";
  let held = args.held;
  if (decision === "reject" && held?.proposal.status === "approved") {
    // Approved, never run (its run failed): an authorized admin withdraws the approval.
    const withdrawn = await getProposalStore().withdraw(
      id,
      decidedBy,
      note?.trim() || "rejected after its run failed"
    );
    if (!withdrawn) {
      return {
        success: false,
        error: "rejection did not commit (already used or decided)",
        response: apiError("approvals.decision_conflict", { request }),
      };
    }
    return {
      success: true,
      response: NextResponse.json({ decision, source, withdrawn: true, requestId }),
    };
  }
  if (decision === "mark_executed") {
    // Verified by a person to have taken effect (review 11 H-1): the approval is used.
    const done = await getProposalStore().resolveIndeterminate(
      id,
      "executed",
      decidedBy,
      note?.trim() || "verified as applied"
    );
    if (!done) {
      return {
        success: false,
        error: "not undecided (its run ended, or another admin decided it)",
        response: apiError("approvals.decision_conflict", { request }),
      };
    }
    return {
      success: true,
      response: NextResponse.json({
        decision,
        source,
        status: done.status,
        requestId,
      }),
    };
  }
  if (decision === "approve" || decision === "reapprove") {
    // An approved hold that could not be run (its resume failed, and its approval was
    // kept) is run again by a new approval from an authorized, independent decider; once
    // it took effect, the approval is used (executed) and cannot run twice (review 10 H2).
    // An undecided run (review 11 H-1) is run again only by an explicit, fresh approval —
    // its decider verified that it did not take effect.
    let outcome: { kind: string };
    if (decision === "reapprove" && held) {
      const again = await getProposalStore().resolveIndeterminate(
        id,
        "approved",
        decidedBy,
        note?.trim() || "approved again: verified that its run did not take effect"
      );
      if (!again) {
        return {
          success: false,
          error: "not undecided (its run ended, or another admin decided it)",
          response: apiError("approvals.decision_conflict", { request }),
        };
      }
      held = { ...held, proposal: again };
      outcome = { kind: "approved" };
    } else {
      outcome =
        held?.proposal.status === "approved"
          ? { kind: "approved" as const }
          : await approveHeldAction({ proposalId: id, decidedBy, note });
    }
    // The approved hold runs now, through its authority (nothing else resumes it) — or,
    // for a safety key under two-person approval, goes on to wait for that approval.
    let resumed:
      { applied: boolean; approval?: unknown; unrecorded?: string } | undefined;
    if (outcome.kind === "approved" && held) {
      const ran: HoldResumeResult = await held.authority
        .resume(held.proposal)
        .catch((err: unknown) => ({
          kind: "failed" as const,
          error: err instanceof Error ? err.message : String(err),
        }));
      if (ran.kind === "applied")
        resumed = {
          applied: true,
          ...(ran.unrecorded ? { unrecorded: ran.unrecorded } : {}),
        };
      else if (ran.kind === "pending")
        resumed = { applied: false, approval: ran.approval };
      else if (ran.kind === "stale") {
        // The key changed since the hold was requested (review 12 H2): nothing was applied. The
        // hold is withdrawn — recorded first — and the requester must ask again.
        const withdrawn = await audited(
          {
            action: "admin_action",
            actorId: decidedBy,
            details: {
              type: "approval_withdrawn",
              reason: "stale",
              holdId: id,
              source,
              label: held.proposal.label,
              key: proposalConfigKey(held.proposal.payload) ?? null,
            },
          },
          async () =>
            (await getProposalStore().withdraw(
              id,
              decidedBy,
              "stale: the setting changed since it was requested"
            ))
              ? { success: true as const }
              : { success: false as const, error: "not withdrawn (no longer approved)" }
        );
        logger.warn("Approved held change was stale; withdrawn", {
          requestId,
          proposalId: id,
          withdrawn: withdrawn.success,
          route: "platform/admin/approval-decision",
        });
        return {
          success: false,
          error: `stale: ${ran.error}`,
          response: apiError("approvals.stale", { request }),
        };
      } else if (ran.kind === "in_use") {
        // Another run holds the approval, or it was used: it runs once.
        return {
          success: false,
          error: `approved hold not run: ${ran.error}`,
          response: apiError("approvals.decision_conflict", { request }),
        };
      } else {
        const error = ran.error;
        logger.error("Approved held change could not be applied", {
          requestId,
          proposalId: id,
          authority: held.authority.name,
          error,
          route: "platform/admin/approval-decision",
        });
        // True: the approval stands (the run's claim was released, or never taken), so
        // approving again retries it (review 10 H2: it said "try again" and then 409).
        return {
          success: false,
          error: `Approved but not applied; approval kept: ${error}`,
          response: apiError("approvals.run_failed", { request }),
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
        // Applied, and its record could not be stored (review 10 M5): said so.
        ...(resumed?.unrecorded ? { recorded: false, warning: resumed.unrecorded } : {}),
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
