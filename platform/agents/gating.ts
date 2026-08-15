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
  _effectiveRisk: RiskLevel,
  _effects: readonly EffectType[]
): AgentIdentity {
  return {
    actorType: "user",
    actorId: "pending-human-approver",
    agentRole: "approver",
  };
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
export async function rejectHeldAction(args: ApproveHeldActionArgs): Promise<void> {
  const proposalStore = args.proposalStore ?? getProposalStore();
  const trajectoryStore = args.trajectoryStore ?? getTrajectoryStore();
  await rejectProposal({
    proposalId: args.proposalId,
    decidedBy: args.decidedBy,
    note: args.note,
    proposalStore,
    trajectoryStore,
  });
}
