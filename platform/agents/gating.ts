/**
 * platform/agents/gating.ts — The agent-facing gating contract (ADR-030 D6, ADR-031)
 *
 * When a workflow step's effectiveRisk reaches the gating threshold, the pipeline holds it:
 * a proposal is minted, the trajectory pauses, and the response carries a HeldAction naming
 * WHO must approve. This module owns two things:
 *
 *   approvalPolicy()    decides which actor TYPE may approve a given held action
 *   approveHeldAction() records a decision and returns the trajectory to running
 *
 * THE APPROVER IS AN IDENTITY, NOT A HUMAN-ONLY FLAG. HeldAction.approver is an
 * AgentIdentity whose actorType is "user" | "agent" | "system". Today approvalPolicy
 * returns "user" for everything — human review, the P10 default. That is a POLICY choice
 * living in one function, NOT a property welded into the contract: moving a class of action
 * to agent approval later is a change to this function (and, in Sprint 3c, to an
 * admin-governed policy store), never a change to the envelope. The seam is deliberate so
 * the agent-approver path stays reachable as the system earns trust (recorded in the
 * ADR-030 amendment of 2026-08-15 so a future planner finds it where they look — GOTCHA-70).
 *
 * approveHeldAction is type-agnostic on WHO decides: it takes a decidedBy actor id and does
 * not care whether that id is a human or an agent. The commit path was already type-blind;
 * this preserves that. What governs whether an agent id is ALLOWED to decide is the policy,
 * not this function.
 *
 * @module platform/agents
 */

import type {
  ActionSpec,
  ActivityStateStore,
  AgentIdentity,
  EffectType,
  ProposalRecord,
  ProposalStore,
  RiskLevel,
  TrajectoryStore,
} from "@/platform/kernel";
import {
  approveProposal,
  approveWithReconciliation,
  rejectProposal,
  type ApprovalOutcome,
} from "@/platform/action-pipeline";
import { getProposalStore } from "./proposal-store";
import { getTrajectoryStore } from "./trajectory-store";
import {
  DEFAULT_APPROVAL_POLICY,
  resolveApprover,
  type ApprovalPolicy,
} from "./approval-policy-store";

/**
 * Which actor type may approve a held action of this risk/effects.
 *
 * DEFAULT: human review for everything (returns actorType "user"). This is the P10
 * default and the ONLY policy Sprint 3b ships. Sprint 3c makes it admin-governed and
 * per-action-class; the agent-approver path (returning actorType "agent") is reachable
 * without touching HeldAction, because actorType "agent" was always a legal value.
 *
 * The role/id are left generic here: the concrete approver identity (which human, which
 * admin role) is a consumer/Playform-A concern. What PF-B fixes is the TYPE required.
 */
export function approvalPolicy(
  effectiveRisk: RiskLevel,
  effects: readonly EffectType[],
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY
): AgentIdentity {
  return resolveApprover(policy, effectiveRisk, effects);
}

export interface ApproveHeldActionArgs {
  readonly proposalId: string;
  /** The actor id recording the decision. Human or agent — the policy governs which is allowed. */
  readonly decidedBy: string;
  readonly note?: string;
  readonly proposalStore?: ProposalStore;
  readonly trajectoryStore?: TrajectoryStore;
  /**
   * When supplied, the decision is reconciled against state that may have advanced since
   * the proposal (ADR-031 D5). Omit only when there is no managed state to move.
   */
  readonly reconcile?: {
    readonly stateStore: ActivityStateStore<unknown>;
    readonly spec?: ActionSpec;
  };
}

/**
 * Approve a held action. Flips the proposal to approved and the trajectory to running, so
 * the workflow can be resumed via runGoal/advanceGoal with the same trajectoryId.
 *
 * Returns the approval outcome. A stale approval (state advanced under a non-commutative
 * action) SUPERSEDES rather than commits (ADR-031 D5) — the caller re-proposes rather than
 * committing an approval for a transition that no longer applies.
 */
export async function approveHeldAction(
  args: ApproveHeldActionArgs
): Promise<ApprovalOutcome> {
  const proposalStore = args.proposalStore ?? getProposalStore();
  const trajectoryStore = args.trajectoryStore ?? getTrajectoryStore();

  if (args.reconcile) {
    return approveWithReconciliation({
      proposalId: args.proposalId,
      decidedBy: args.decidedBy,
      note: args.note,
      proposalStore,
      trajectoryStore,
      stateStore: args.reconcile.stateStore,
      spec: args.reconcile.spec,
    });
  }

  const approved = await approveProposal({
    proposalId: args.proposalId,
    decidedBy: args.decidedBy,
    note: args.note,
    proposalStore,
    trajectoryStore,
  });
  return approved
    ? { kind: "approved", proposal: approved }
    : { kind: "already-decided", proposal: undefined };
}

/**
 * Reject a held action. Terminal: the trajectory records what was proposed and why it was
 * refused, and no stateVersion is ever produced (ADR-031 D8).
 */
export async function rejectHeldAction(
  args: ApproveHeldActionArgs
): Promise<ProposalRecord | undefined> {
  const proposalStore = args.proposalStore ?? getProposalStore();
  const trajectoryStore = args.trajectoryStore ?? getTrajectoryStore();
  // The decided record, or undefined when the proposal had already been decided (an approve
  // won the race): the caller must not report a rejection that did not happen.
  return rejectProposal({
    proposalId: args.proposalId,
    decidedBy: args.decidedBy,
    note: args.note,
    proposalStore,
    trajectoryStore,
  });
}

// ── Who may decide a held action (PF v5.1.0) ──────────────────────────

/**
 * The user an actor stands for: a user acting directly is themselves (a claimed onBehalfOf is
 * ignored); an agent stands for the user it acts on behalf of — and when its delegation is
 * attested, only if the claim matches the attestation. Undefined for a system actor, an agent
 * acting for nobody, a mismatched claim or an empty id. A held action belongs to its proposer's
 * principal; a trajectory to its creator's (workflow-loop openTrajectory).
 */
export function principalOf(actor: AgentIdentity): string | undefined {
  if (actor.actorType === "user") return actor.actorId || undefined;
  if (actor.actorType !== "agent" || !actor.onBehalfOf) return undefined;
  if (actor.delegation && actor.delegation.onBehalfOf !== actor.onBehalfOf)
    return undefined;
  return actor.onBehalfOf;
}

/** Why a decision on a held action is refused (each maps to a coded error in a route). */
export type HeldActionRefusal =
  /** No such proposal, or not the decider's: answered identically, so existence is not revealed. */
  | "not_found"
  /** Already approved, rejected or superseded. */
  | "not_open"
  /** The proposer deciding its own action — the same agent, or the same sign-in session. */
  | "self_approval"
  /** The approval policy requires another kind of approver (a human, by default). */
  | "approver_not_allowed";

/**
 * Whether `decider` may make `decision` on `proposal` (Playform v0.8.0 release review).
 *
 *   ownership    — the proposal was made for the decider's principal; a proposal with no owner
 *                  (a row from before migration 046) belongs to nobody and is refused
 *   open         — it is still awaiting a decision
 *   independence — approving only: never by the proposing agent, and never through the sign-in
 *                  session the action was proposed through, whoever proposed it (an agent given
 *                  the user's session can propose and approve as the user by leaving its
 *                  delegation token off — only a different session shows a different party);
 *                  when either session is unknown, independence cannot be shown and the
 *                  approval is refused. And only by the actor type the approval policy requires
 *                  for the action's risk and effects
 *
 * Rejecting needs ownership only: refusing is always within the owner's right and makes nothing
 * happen. Returns null when the decision may proceed. The store's conditional decide still guards
 * the race between this check and the write.
 */
export function heldActionRefusal(
  proposal: ProposalRecord | undefined,
  decider: AgentIdentity,
  decision: "approve" | "reject",
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY
): HeldActionRefusal | null {
  const owner = proposal ? principalOf(proposal.actor) : undefined;
  if (!proposal || owner === undefined || owner !== principalOf(decider)) {
    return "not_found";
  }
  if (proposal.status !== "proposed") return "not_open";
  if (decision === "reject") return null;

  const proposer = proposal.actor;
  if (
    proposer.actorType !== "user" &&
    decider.actorType === proposer.actorType &&
    decider.actorId === proposer.actorId
  ) {
    return "self_approval";
  }
  // Independence is shown by session: the provider must report one (TokenPayload.sessionId).
  if (!proposer.sessionId || !decider.sessionId) return "approver_not_allowed";
  if (decider.sessionId === proposer.sessionId) return "self_approval";
  const required = approvalPolicy(proposal.effectiveRisk, proposal.effects, policy);
  return decider.actorType === required.actorType ? null : "approver_not_allowed";
}
