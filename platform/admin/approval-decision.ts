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
 * decider verified it took effect; the hold's permission needed), "reapprove" (verified it did
 * not; a fresh approval, independent of the requester and under the hold's scope rules, run at
 * once, once) or "withdraw" (verified it did not, and it is not to run: closed as rejected, never
 * run — TASK-194 round 5; independent of the requester, the hold's permission needed). "approve"
 * and "reject" on it answer approvals.indeterminate, and the three decisions on anything else
 * approvals.decision_conflict. Each is recorded (approval_decision). A "reapprove" of a hold its
 * authority finds duplicates an older open one (duplicateOf: a second erasure of one account)
 * answers approvals.duplicate_undecided (round 8) and changes nothing — it would run the action a
 * second time; such a hold, verified not applied, is withdrawn.
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
  APPLY_LEASE_SECONDS,
  rejectChange,
} from "@/platform/admin/config-approval";
import { requiredPermissionForKey } from "@/platform/admin/pending-approvals";
import { withdrawLapsedHold } from "@/platform/admin/lapsed-hold";
import {
  apiError,
  apiErrorBody,
  errorFromResult,
  readJsonObject,
} from "@/platform/errors";
import { ERROR_CODES, type ErrorCode } from "@/platform/errors/registry";
import { settlesWithinMinutes } from "@/platform/admin/approval-settle";
import { LOST_COMMIT_CODE } from "@/platform/action-pipeline";
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
  RUN_LEASE_SECONDS,
} from "@/platform/admin/hold-expiry";
import { sameId } from "@/platform/auth/same-id";
import { requiredJobWithdrawalNote } from "@/platform/jobs/required-schedule";

/** A users.id's shape: only an account id is a record's target (recordAudit refuses another). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who rejects a hold that duplicates another (TASK-199): the system, not the decider. */
export const DUPLICATE_HOLD_ACTOR = "system:duplicate-hold";

/**
 * Who withdraws an approved hold that is stale or refused for good when it runs (round 21, I-2):
 * the system — as a lapse, a duplicate and a config approval's apply are withdrawn — with the
 * decider recorded as who found it.
 */
export const REFUSED_HOLD_ACTOR = "system:held-change-refused";

/** The note on a hold refused for good, by its code (round 21, nit 2). */
function refusedHoldNote(code: ErrorCode, proposal: ProposalRecord): string {
  const key = proposalConfigKey(proposal.payload);
  return code === "jobs.schedule_required" && key
    ? `refused: ${requiredJobWithdrawalNote(key)}`
    : `refused: ${code}`;
}

/**
 * Withdraw an approved hold that is stale or refused for good (round 21, I-2): recorded first
 * (approval_withdrawn — the system as the agent, the decider as `foundBy`, who had approved it and
 * when), then withdrawn as the system, its trajectory settled with it (as a lapse's). Whether it
 * was withdrawn: false when it is no longer approved. AuditWriteError when the record cannot be
 * written (nothing is withdrawn).
 */
async function withdrawRefusedHold(
  /** A code, never free text (audit-details' rule: a literal-union parameter). */
  reason: "stale" | "refused",
  args: {
    readonly id: string;
    readonly source: string;
    readonly decidedBy: string;
    readonly proposal: ProposalRecord;
    readonly note: string;
  }
): Promise<boolean> {
  const { id, source, decidedBy, proposal, note } = args;
  // Who approved it and when: the hold as it stands now (approved just now, or kept from before).
  const approved = (await getProposalStore().getById(id)) ?? proposal;
  const outcome = await audited(
    {
      action: "admin_action",
      agent: REFUSED_HOLD_ACTOR,
      details: {
        type: "approval_withdrawn",
        reason,
        holdId: id,
        source,
        label: proposal.label,
        key: proposalConfigKey(proposal.payload) ?? null,
        approvedBy: approved.decidedBy ?? null,
        approvedAt: approved.decidedAt ?? null,
        foundBy: decidedBy,
      },
    },
    async () => {
      const withdrawn = await getProposalStore().withdraw(id, REFUSED_HOLD_ACTOR, note);
      // Settled here, then again by decideRuntimeHold's `finally` (round 22, N-1; round 23, nit
      // 1): its one caller today (decideRuntimeHoldNow) runs inside that `try`, so this settle runs
      // first and the `finally`'s is the no-op (each move is a compare-and-set from an open
      // status). Kept so the helper stays correct called from anywhere else, as
      // withdrawLapsedHold and refuseDuplicateHold settle their own.
      await Promise.resolve()
        .then(() => settleHeldTrajectory(getTrajectoryStore(), withdrawn))
        .catch(() => undefined);
      return withdrawn
        ? { success: true as const }
        : { success: false as const, error: "not withdrawn (no longer approved)" };
    }
  );
  return outcome.success;
}

interface DecisionBody {
  decision?: string;
  source?: string;
  note?: string;
}

/**
 * The answer to a config approval whose apply failed: its code (errorFromResult) and, for the
 * screen, what became of the approval (round 16, items 3–4) — `withdrawn` by the system, or
 * `settling` (approved, its outcome checked by the apply recovery) with when it is listed again.
 */
async function configDecisionFailure(
  result: Parameters<typeof errorFromResult>[0] & { withdrawn?: true; settling?: true },
  request: NextRequest
): Promise<NextResponse> {
  const failed = errorFromResult(result, {
    request,
    context: "Approval decision failed",
  });
  if (!result.withdrawn && !result.settling) return failed;
  return NextResponse.json(
    {
      ...((await failed.json()) as Record<string, unknown>),
      ...(result.withdrawn ? { withdrawn: true } : {}),
      ...(result.settling
        ? {
            settling: true,
            settlesWithinMinutes: await settlesWithinMinutes(APPLY_LEASE_SECONDS),
          }
        : {}),
    },
    { status: failed.status, headers: failed.headers }
  );
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
    decision !== "reapprove" &&
    decision !== "withdraw"
  ) {
    return apiError("request.invalid_value", {
      params: {
        field: "decision",
        allowed: ["approve", "reject", "mark_executed", "reapprove", "withdraw"],
      },
      request,
    });
  }
  // A decision on an approved run whose outcome is unknown (review 11 H-1): only a runtime hold.
  const onUndecided =
    decision === "mark_executed" || decision === "reapprove" || decision === "withdraw";
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
  // declare their own change applied either — nor, withdrawing it, declare it not applied.
  // Holds recorded before Sprint 7X may name the requester by identity-provider subject.
  if (
    (decision === "approve" ||
      decision === "reapprove" ||
      decision === "mark_executed" ||
      decision === "withdraw") &&
    requesters.some((r) => sameId(r, admin.userId) || sameId(r, admin.sub))
  ) {
    return apiError("approvals.self_approval", { request });
  }
  if (!holds(admin, requiredPermission)) {
    return apiError("approvals.permission_required", {
      params: { permission: requiredPermission },
      request,
    });
  }
  // Never on one's own account (TASK-194 round 1, A3): a decider is not the account the held
  // action acts on, whatever the action — a restriction, an erasure, a role change — and whatever
  // the decision: approve, reapprove, mark_executed, and withdraw and reject too (round 6, I-1,
  // P-1: the target of an erasure must not withdraw or reject it either). Unreadable: no decision.
  // The account it acts on, read once: refused to decide here, and named by the decision's record
  // (round 7, I-1: the record's note is erased with that account only if the record names it).
  let target: string | null | undefined;
  if (held?.authority.targetAccount) {
    try {
      target = await held.authority.targetAccount(held.proposal);
    } catch (err) {
      logger.error("Held action's target could not be read", {
        holdId: id,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/admin/approval-decision",
      });
      return apiError("service.unavailable", { params: { service: "roles" }, request });
    }
    // An account not found is not the approver's (theirs exists); the action reports it itself.
    if (target && (sameId(target, admin.userId) || sameId(target, admin.sub))) {
      return apiError("admin.self_target", { request });
    }
  }
  // The change's own rules, for the approver (TASK-194, audit C-2): an approver must be able to
  // make the change themselves — a role change only by one holding every permission of both
  // roles, never of a protected role, never their own. Unreadable rules: no decision.
  if (
    held?.authority.approverRuleRefusal &&
    (decision === "approve" || decision === "reapprove" || decision === "mark_executed")
  ) {
    let refused;
    try {
      refused = await held.authority.approverRuleRefusal(held.proposal, admin);
    } catch (err) {
      logger.error("Approver rule check failed", {
        holdId: id,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/admin/approval-decision",
      });
      return apiError("service.unavailable", { params: { service: "roles" }, request });
    }
    if (refused) return apiError(refused.code, { params: refused.params, request });
  }

  // Every decision is recorded before it takes effect, naming the decider and the requester
  // (release review, Sprint 7X: decisions left no audit record) — and the account the held action
  // acts on, as its target: the decider's note about it is erased with that account (round 7,
  // I-1; platform/auth/user-data.ts auditText finds a record by its target).
  const entry = {
    action: "admin_action" as const,
    actorId: decidedBy,
    ...(target && UUID_SHAPE.test(target) ? { targetId: target } : {}),
    details: {
      type: "approval_decision",
      holdId: id,
      source,
      decision,
      requester,
      requiredPermission,
      ...(held ? { authority: held.authority.name, label: held.proposal.label } : {}),
      // The decider's note (free text: erased with the target account, round 7, I-1), and who had
      // approved the hold before this decision (round 6, P-2): a withdrawal, a re-approval or a
      // run marked executed is about an approval already given.
      ...(note?.trim() ? { note: note.trim() } : {}),
      ...(held?.proposal.decidedBy ? { approvedBy: held.proposal.decidedBy } : {}),
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
    if (holdLapsed(held.proposal, days)) {
      try {
        await withdrawLapsedHold({
          proposal: held.proposal,
          days,
          source: "runtime",
          foundBy: decidedBy,
        });
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

  // A duplicate of another open hold (TASK-199): rejected by the system, never approved.
  if (held && decision === "approve") {
    const refused = await refuseDuplicateHold({ request, id, source, decidedBy, held });
    if (refused) return refused;
  }
  // An undecided duplicate is never approved again (TASK-194 round 5): that would run the action
  // a second time while the older hold is open. Nothing changes; verified not applied, it is
  // withdrawn ("withdraw"), and verified applied, marked executed.
  if (held && decision === "reapprove" && held.authority.duplicateOf) {
    let duplicate: Awaited<ReturnType<NonNullable<HoldAuthority["duplicateOf"]>>>;
    try {
      duplicate = await held.authority.duplicateOf(held.proposal);
    } catch (err) {
      logger.error("Held action's duplicates could not be read", {
        holdId: id,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/admin/approval-decision",
      });
      return apiError("service.unavailable", {
        params: { service: "approvals" },
        request,
      });
    }
    // Its own code (round 8, item 1): what to do with this hold — not a new request's answer.
    if (duplicate) return apiError("approvals.duplicate_undecided", { request });
  }

  try {
    const done = await audited(
      entry,
      async () => {
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
        // An approved change is applied in the same outcome. One that cannot be applied is, as
        // its failure says (approveAndApply; round 15, P-1; round 16, items 3–4): reopened;
        // withdrawn by the system when the withdrawal lands (stale, a value refused — else left
        // to settle); or — a lost commit — left approved and unapplied, settled by the apply
        // recovery.
        const result =
          decision === "approve"
            ? await approveAndApply(id, decidedBy, note ?? "", (record) => {
                const target = approvedChangeTarget(isOperator(admin), record.scope);
                // Coded (round 15, P-1): a place the reviewer may not write.
                if (!target.ok)
                  return Promise.resolve({
                    success: false,
                    error: target.reason,
                    errorCode: "admin.config_scope_refused",
                    errorParams: { key: record.configKey },
                  });
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
          const response = await configDecisionFailure(result, request);
          // A lost commit is audited indeterminate, never failed (round 16, item 2).
          return {
            success: false,
            error: result.error,
            ...(result.errorCode === LOST_COMMIT_CODE ? { indeterminate: true } : {}),
            response,
          };
        }
        return {
          success: true,
          response: NextResponse.json({ decision, source, requestId }),
        };
        // A runtime hold's approval runs it through its authority (HoldAuthority.resume,
        // @external): an erasure reaches the identity provider (round 9, P-1).
      },
      { external: true }
    );
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
  readonly decision: "approve" | "reject" | "mark_executed" | "reapprove" | "withdraw";
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
  if (decision === "withdraw") {
    // Verified by a person not to have taken effect, and not to run (TASK-194 round 5): closed as
    // rejected, never run — the decider, the time and the note recorded on the hold.
    const gone = await getProposalStore().resolveIndeterminate(
      id,
      "rejected",
      decidedBy,
      note?.trim() || "verified that its run did not take effect"
    );
    if (!gone) {
      return {
        success: false,
        error: "not undecided (its run ended, or another admin decided it)",
        response: apiError("approvals.decision_conflict", { request }),
      };
    }
    return {
      success: true,
      response: NextResponse.json({ decision, source, status: gone.status, requestId }),
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
        .catch((err: unknown) => {
          // Its text is logged, never carried (round 15, I-4).
          logger.error("Approved held change could not be run", {
            requestId,
            proposalId: id,
            error: err instanceof Error ? err.message : String(err),
            route: "platform/admin/approval-decision",
          });
          return {
            kind: "failed" as const,
            error: "The approved change could not be run.",
          };
        });
      if (ran.kind === "applied")
        resumed = {
          applied: true,
          ...(ran.unrecorded ? { unrecorded: ran.unrecorded } : {}),
        };
      else if (ran.kind === "pending")
        resumed = { applied: false, approval: ran.approval };
      else if (ran.kind === "stale" || ran.kind === "refused") {
        // Stale (review 12 H2: the key changed since it was requested) or refused for good
        // (round 20, residual A: a required job's key, held before the job was required): nothing
        // was applied, and approving it again could only fail the same way. Withdrawn by the
        // system — recorded first, the decider as who found it (round 21, I-2) — and answered with
        // its code and, when the withdrawal landed, `withdrawn: true`, so the panels read the list
        // again. A run whose claim was kept never reaches here (resumeFailure, round 21, I-1).
        const withdrawn = await withdrawRefusedHold(ran.kind, {
          id,
          source,
          decidedBy,
          proposal: held.proposal,
          note:
            ran.kind === "stale"
              ? "stale: what it would replace changed since it was requested"
              : refusedHoldNote(ran.code, held.proposal),
        });
        const code: ErrorCode = ran.kind === "stale" ? "approvals.stale" : ran.code;
        logger.warn("Approved held change not applied: stale or refused for good", {
          requestId,
          proposalId: id,
          code,
          withdrawn,
          route: "platform/admin/approval-decision",
        });
        return {
          success: false,
          error: `${ran.kind}: ${ran.error}`,
          response: NextResponse.json(
            {
              ...apiErrorBody(code, {
                params: ran.kind === "refused" ? { ...(ran.params ?? {}) } : {},
                request,
              }),
              ...(withdrawn ? { withdrawn: true } : {}),
            },
            { status: ERROR_CODES[code].status }
          ),
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
        // The approval stands when the run's claim was released, or never taken — approving
        // again retries it (review 10 H2: it said "try again" and then 409); `approvalKept` says
        // so to the screen, which says what to do (round 15, I-1). Why it did not apply, when the
        // run said (round 14, item 1; round 15, I-1: through the pipeline's release): a change
        // to the key already waiting for approval, the audit log unavailable, a lost commit —
        // its own code. A claim that could not be given back is no approval standing: its run's
        // outcome is a person's to decide once its lease has passed (approvals.indeterminate).
        const kept = ran.approvalKept !== false;
        const code: ErrorCode = !kept
          ? "approvals.indeterminate"
          : ran.code &&
              ran.code !== "admin.action_failed" &&
              ran.code !== "internal.error"
            ? ran.code
            : "approvals.run_failed";
        // Not kept — its write lost its commit (round 16, item 1), or the release could not be
        // written: the screen says when it is listed as undecided.
        const said = NextResponse.json(
          {
            ...apiErrorBody(code, {
              params: kept && code === ran.code ? { ...(ran.params ?? {}) } : {},
              request,
            }),
            approvalKept: kept,
            ...(kept
              ? {}
              : {
                  undecidedWithinMinutes: await settlesWithinMinutes(RUN_LEASE_SECONDS),
                }),
          },
          { status: ERROR_CODES[code].status }
        );
        // The record says what is true of the approval (round 16, item 5), and a lost commit is
        // audited indeterminate, never failed (item 2): the write may stand.
        return {
          success: false,
          error: kept
            ? `Approved but not applied; approval kept: ${error}`
            : `Approved but not applied; its run's claim not given back, undecided once its lease has passed: ${error}`,
          ...(ran.code === LOST_COMMIT_CODE ? { indeterminate: true } : {}),
          response: said,
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

/**
 * When `held` is an undecided hold its authority says another, older open hold already covers
 * (TASK-199: HoldAuthority.duplicateOf), reject it — the system's decision, recorded before it is
 * made — and answer the authority's code; undefined when it is no duplicate. Unreadable: 503.
 */
async function refuseDuplicateHold(args: {
  readonly request: NextRequest;
  readonly id: string;
  readonly source: string;
  readonly decidedBy: string;
  readonly held: { readonly proposal: ProposalRecord; readonly authority: HoldAuthority };
}): Promise<NextResponse | undefined> {
  const { request, id, source, decidedBy, held } = args;
  if (!held.authority.duplicateOf) return undefined;
  let duplicate: Awaited<ReturnType<NonNullable<HoldAuthority["duplicateOf"]>>>;
  try {
    duplicate = await held.authority.duplicateOf(held.proposal);
  } catch (err) {
    logger.error("Held action's duplicates could not be read", {
      holdId: id,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/approval-decision",
    });
    return apiError("service.unavailable", { params: { service: "approvals" }, request });
  }
  if (!duplicate) return undefined;
  try {
    await audited(
      {
        action: "admin_action",
        agent: DUPLICATE_HOLD_ACTOR,
        details: {
          type: "approval_withdrawn",
          reason: "duplicate",
          holdId: id,
          source,
          label: held.proposal.label,
          decision: "undecided",
          requestedAt: held.proposal.createdAt,
          holdIds: [duplicate.holdId],
          foundBy: decidedBy,
        },
      },
      async () => {
        const rejected = await getProposalStore().decide(
          id,
          "rejected",
          DUPLICATE_HOLD_ACTOR,
          `duplicate of hold ${duplicate.holdId}, which stands`
        );
        await Promise.resolve()
          .then(() => settleHeldTrajectory(getTrajectoryStore(), rejected))
          .catch(() => undefined);
        return rejected
          ? { success: true as const }
          : { success: false as const, error: "already decided" };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    }
    throw err;
  }
  return apiError(duplicate.code, { request });
}
