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
 */
import {
  executeActionPipeline,
  isPipelineConflict,
  PipelineRejectedError,
} from "@/platform/action-pipeline";
import type { PipelineRejectionReason } from "@/platform/action-pipeline";
import type {
  ActionSpec,
  AgentIdentity,
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
}

/**
 * Route a governed effect through the D3 pipeline. Boundary is forced to "commitment"; the pipeline
 * computes risk from the spec (a caller cannot smuggle a lower risk). Rejections become
 * held/rejected; a CAS loss becomes conflict; unexpected errors propagate.
 */
export async function routeGovernedEffect<TState>(
  req: GovernedEffectRequest<TState>
): Promise<GovernedEffectOutcome<TState>> {
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
      operationId: req.operationId,
      budgetCeiling: req.budgetCeiling,
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
      return {
        status: err.reason === "requires-approval" ? "held" : "rejected",
        reason: err.reason,
      };
    }
    throw err;
  }
}
