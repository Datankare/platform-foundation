/**
 * platform/adaptive/effect.ts — routing an adaptive decision's effect through the D3 pipeline
 * (ADR-036 D4).
 *
 * runAdaptive has no state-mutation path: the loop produces a validated decision and mutates
 * nothing but its own within-session memory. When a decision is effectful, the consumer routes it
 * here — the single governed path. The effect is FORCED to boundary "commitment" (P17; the caller
 * cannot downgrade it) and executed via executeActionPipeline, so every adaptive effect inherits
 * CAS, risk gating, and the held-action / dual-control path — no route around the controls every
 * other action passes through. The pipeline's outcomes are translated to one AdaptiveEffectOutcome.
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

export type AdaptiveEffectStatus = "applied" | "held" | "rejected" | "conflict";

export interface AdaptiveEffectOutcome<TState> {
  readonly status: AdaptiveEffectStatus;
  /** Present when applied (null for an action writing no managed state). */
  readonly committed?: VersionedState<TState> | null;
  /** Present when held or rejected — why the pipeline refused. */
  readonly reason?: PipelineRejectionReason;
  /** Present on a CAS conflict, so the caller can revalidate and retry. */
  readonly currentVersion?: number;
  readonly currentState?: TState;
}

export interface AdaptiveEffectRequest<TState> {
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
 * Route an effectful adaptive decision through the governed pipeline. Boundary is forced to
 * "commitment"; the pipeline computes risk from the spec (a caller cannot smuggle a lower risk).
 * Rejections become held/rejected; a CAS loss becomes conflict; unexpected errors propagate.
 */
export async function routeAdaptiveEffect<TState>(
  req: AdaptiveEffectRequest<TState>
): Promise<AdaptiveEffectOutcome<TState>> {
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
