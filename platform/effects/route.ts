/**
 * platform/effects/route.ts — the shared governed-effect router.
 *
 * The single implementation both the adaptive framework (ADR-036 D4) and the content framework
 * (ADR-037 D5) route their effects through, rather than each duplicating it. An effectful
 * decision or a durable content surface is FORCED to boundary "commitment" (P17; the caller cannot
 * downgrade it) and executed via executeActionPipeline, so every governed effect inherits CAS,
 * risk gating, and the held-action / dual-control path — no route around the controls every other
 * action passes through. The pipeline's outcomes are translated to one GovernedEffectOutcome:
 * applied (committed/surfaced), held (approval required), rejected (refused), or conflict (CAS loss).
 *
 * A held effect is held for real (audit C-13): a proposal is minted for it (idempotent per
 * operation), its id returned, so an approver can find and decide it; the effect then runs when
 * the caller routes it again with `approvedProposalId` — the pipeline verifies that approval for
 * this operation, label and computed state, and claims it so it runs once. Before, a held effect
 * was reported "held" and dropped: nothing could ever approve it.
 */
import {
  executeActionPipeline,
  isPipelineConflict,
  PipelineRejectedError,
  proposeOnce,
} from "@/platform/action-pipeline";
import { generateSecureId } from "@/platform/agents/utils";
import { getProposalStore } from "@/platform/agents/proposal-store";
import type { PipelineRejectionReason } from "@/platform/action-pipeline";
import type {
  ActionSpec,
  AgentIdentity,
  ProposalStore,
  TrajectoryStore,
  VersionedState,
} from "@/platform/kernel/types";
import type { ActivityStateStore } from "@/platform/kernel/state-store";

export type GovernedEffectStatus = "applied" | "held" | "rejected" | "conflict";

export interface GovernedEffectOutcome<TState> {
  readonly status: GovernedEffectStatus;
  /** Present when applied — the committed/surfaced state (null for an effect writing no managed state). */
  readonly committed?: VersionedState<TState> | null;
  /** Present when held or rejected — why the pipeline refused. */
  readonly reason?: PipelineRejectionReason;
  /** Present on a CAS conflict, so the caller can revalidate and retry. */
  readonly currentVersion?: number;
  readonly currentState?: TState;
  /** Present when held: the proposal an approver decides, and the operation it is for. */
  readonly proposalId?: string;
  readonly operationId?: string;
}

export interface GovernedEffectRequest<TState> {
  readonly spec: ActionSpec;
  readonly actor: AgentIdentity;
  readonly sessionId: string;
  readonly label: string;
  readonly cost: number;
  readonly stateStore: ActivityStateStore<TState>;
  readonly trajectoryStore: TrajectoryStore;
  readonly trajectoryId: string;
  readonly stepIndex: number;
  readonly expectedVersion: number;
  readonly computeNextState: () => TState;
  readonly operationId?: string;
  readonly budgetCeiling?: number;
  /** Where a held effect's proposal is kept (default: the platform's proposal store). */
  readonly proposalStore?: ProposalStore;
  /** Run a held effect that was approved: its proposal (with the same operationId). */
  readonly approvedProposalId?: string;
}

/**
 * Route a governed effect through the D3 pipeline. Boundary is forced to "commitment"; the pipeline
 * computes risk from the spec (a caller cannot smuggle a lower risk). Rejections become
 * held/rejected; a CAS loss becomes conflict; unexpected errors propagate.
 */
export async function routeGovernedEffect<TState>(
  req: GovernedEffectRequest<TState>
): Promise<GovernedEffectOutcome<TState>> {
  // One operation id for the attempt and its hold, so the approval is for this very effect.
  const operationId = req.operationId ?? `op_${generateSecureId()}`;
  const proposalStore = req.proposalStore ?? getProposalStore();
  try {
    const outcome = await executeActionPipeline<TState>({
      spec: req.spec,
      actor: req.actor,
      sessionId: req.sessionId,
      label: req.label,
      cost: req.cost,
      boundary: "commitment",
      stateStore: req.stateStore,
      trajectoryStore: req.trajectoryStore,
      trajectoryId: req.trajectoryId,
      stepIndex: req.stepIndex,
      expectedVersion: req.expectedVersion,
      computeNextState: req.computeNextState,
      operationId,
      budgetCeiling: req.budgetCeiling,
      proposalStore,
      approvedProposalId: req.approvedProposalId,
      // What runs is what was approved: the state the effect would commit.
      approvalInput: req.approvedProposalId ? effectPayload(req) : undefined,
    });
    if (isPipelineConflict(outcome)) {
      return {
        status: "conflict",
        currentVersion: outcome.currentVersion,
        currentState: outcome.currentState,
      };
    }
    return { status: "applied", committed: outcome.committed };
  } catch (err) {
    if (err instanceof PipelineRejectedError) {
      if (err.reason !== "requires-approval" || req.approvedProposalId) {
        return { status: "rejected", reason: err.reason };
      }
      const proposal = await proposeOnce({
        spec: req.spec,
        actor: req.actor,
        sessionId: req.sessionId,
        trajectoryId: req.trajectoryId,
        stepIndex: req.stepIndex,
        label: req.label,
        operationId,
        payload: effectPayload(req),
        observedVersion: req.expectedVersion,
        proposalStore,
        trajectoryStore: req.trajectoryStore,
      });
      return {
        status: "held",
        reason: err.reason,
        proposalId: proposal.proposalId,
        operationId,
      };
    }
    throw err;
  }
}

/** What a held effect's approver sees and what its approval binds: the state it would commit. */
function effectPayload<TState>(
  req: GovernedEffectRequest<TState>
): Record<string, unknown> {
  return { label: req.label, nextState: req.computeNextState() as unknown };
}
