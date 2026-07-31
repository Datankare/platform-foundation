/**
 * platform/action-pipeline/index.ts — The governed execution pipeline (ADR-029 D2)
 *
 * ONE implementation of the sequence every action traverses, whatever invoked it:
 *
 *   operationId (minted or supplied) → tier resolution → gating → budget ceiling →
 *   state commit via CAS → trajectory append → event emit
 *
 * Two adapters sit above it and own only domain-specific behaviour:
 *
 *   app-framework/session.ts  dispatch()    — turn rules, validateAction, applyAction,
 *                                             next-action affordances
 *   agents/runtime.ts         invokeTool()  — schema validation, tool execution (commit 3)
 *
 * D2 says a tool call "is not a separate execution path". That binds the pipeline, not the
 * entry point: two entry points are fine, two implementations of gating/CAS/trajectory are
 * not. Forcing tool calls through dispatch() would drag session-specific orchestration —
 * turn enforcement, affordance enumeration, an ActivitySession per agent run — into agent
 * execution, which D2's own closing paragraph guards against.
 *
 * This module imports ONLY platform/kernel. Both stores arrive as parameters rather than
 * via singletons, because a singleton accessor lives in the module that owns the
 * implementation and importing it here would close the cycle this layering exists to open.
 *
 * @module platform/action-pipeline
 */

import type {
  ActionContext,
  ActionSpec,
  ActivityStateStore,
  AgentIdentity,
  DurabilityTier,
  SessionEvent,
  Step,
  StepBoundary,
  Trajectory,
  TrajectoryStore,
  VersionedState,
} from "@/platform/kernel";
import { generateSecureId } from "@/platform/agents/utils";
import { assembleActionContext, computeEffectiveRisk, resolveTier } from "./risk";

// ── Rejection ─────────────────────────────────────────────────────────

export type PipelineRejectionReason = "requires-approval" | "budget-exceeded";

/** Raised when the pipeline refuses before any state mutation. */
export class PipelineRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: PipelineRejectionReason
  ) {
    super(message);
    this.name = "PipelineRejectedError";
  }
}

// ── Request / outcome ─────────────────────────────────────────────────

export interface PipelineRequest<TState> {
  /** The declared spec — risk and effects are computed from it, never accepted from a caller. */
  readonly spec: ActionSpec;
  readonly actor: AgentIdentity;
  readonly sessionId: string;
  /**
   * ADR-031 D1: supplied by the caller for retry safety, minted here when absent.
   * When present it is the idempotency key and the call is a retry of that logical action.
   */
  readonly operationId?: string;
  /** What the trajectory step records as the action — an action type or a tool id. */
  readonly label: string;
  readonly cost: number;
  readonly boundary: StepBoundary;

  readonly stateStore: ActivityStateStore<TState>;
  readonly trajectoryStore: TrajectoryStore;
  readonly trajectoryId: string;
  readonly stepIndex: number;
  readonly expectedVersion: number;

  /**
   * Produces the next managed state, or null when this action writes no managed state —
   * a read-only tool, for instance. A null writer skips the commit and still appends a
   * trajectory step, so ADR-029's "exactly one trajectory step per invocation" holds.
   */
  readonly computeNextState: (() => TState) | null;

  /** Session or agent ceiling in USD; absent = unbounded. */
  readonly budgetCeiling?: number;
  /**
   * Names whose ceiling this is, for the rejection message — "session ceiling",
   * "agent ceiling". The pipeline does not know which budget it is holding; the adapter
   * does, and a caller needs to know which one rejected it.
   */
  readonly ceilingLabel?: string;
  readonly emit?: (event: SessionEvent) => void;
  readonly stepInput?: Record<string, unknown>;
  readonly stepOutput?: Record<string, unknown>;
  readonly eventIntent?: string;
}

export interface PipelineConflict<TState> {
  readonly conflict: true;
  readonly currentVersion: number;
  readonly currentState: TState;
}

export interface PipelineSuccess<TState> {
  readonly conflict?: false;
  readonly tier: DurabilityTier;
  readonly context: ActionContext;
  /** null for ephemeral actions and for actions writing no managed state. */
  readonly committed: VersionedState<TState> | null;
  readonly step: Step | null;
  readonly trajectory: Trajectory | null;
}

export type PipelineOutcome<TState> = PipelineSuccess<TState> | PipelineConflict<TState>;

export function isPipelineConflict<TState>(
  outcome: PipelineOutcome<TState>
): outcome is PipelineConflict<TState> {
  return (outcome as PipelineConflict<TState>).conflict === true;
}

// ── The pipeline ──────────────────────────────────────────────────────

/**
 * Execute one governed action. The stages are fixed and their order is the contract:
 * nothing commits before gating, nothing appends a trajectory step before the commit it
 * describes, and a CAS loss mutates nothing.
 */
export async function executeActionPipeline<TState>(
  req: PipelineRequest<TState>
): Promise<PipelineOutcome<TState>> {
  // 1. Tier + gating. Computed from the spec so no caller can smuggle a lower risk (P4).
  const tier = resolveTier(req.spec);
  if (tier === "two-phase") {
    throw new PipelineRejectedError(
      `${req.label} requires approval (effectiveRisk=${computeEffectiveRisk(req.spec)}) — use propose/approve (ADR-031)`,
      "requires-approval"
    );
  }

  // 2. Budget ceiling — most-restrictive-wins (ADR-028 D10).
  if (req.budgetCeiling !== undefined && req.cost > req.budgetCeiling) {
    throw new PipelineRejectedError(
      `cost ${req.cost} exceeds ${req.ceilingLabel ?? "ceiling"} ${req.budgetCeiling}`,
      "budget-exceeded"
    );
  }

  // 3. Identity. ADR-031 D1 — the caller may supply it, and then it IS the idempotency key.
  // 128-bit even though it is an audit key rather than a capability: a guessable id would
  // let a caller collide with another actor's in-flight operation.
  const operationId = req.operationId ?? `op_${generateSecureId()}`;

  // 4. Ephemeral actions leave no durable trace at all (ADR-028 D3 invariant).
  if (tier === "ephemeral") {
    return {
      tier,
      context: assembleActionContext({
        spec: req.spec,
        actor: req.actor,
        sessionId: req.sessionId,
        operationId,
        boundary: req.boundary,
      }),
      committed: null,
      step: null,
      trajectory: null,
    };
  }

  // 5. The justification record (ADR-031 D9).
  const context = assembleActionContext({
    spec: req.spec,
    actor: req.actor,
    sessionId: req.sessionId,
    operationId,
    boundary: req.boundary,
  });

  // 6. Commit managed state, if this action writes any.
  let committed: VersionedState<TState> | null = null;
  if (req.computeNextState) {
    const nextState = req.computeNextState();
    if (req.spec.commutative) {
      committed = await req.stateStore.reduceCommit(
        req.sessionId,
        () => nextState,
        operationId
      );
    } else {
      const res = await req.stateStore.commit(
        req.sessionId,
        req.expectedVersion,
        nextState,
        operationId
      );
      if (!res.ok) {
        // A lost CAS mutates nothing — no trajectory append, no event (ADR-028 D5).
        return {
          conflict: true,
          currentVersion: res.currentVersion,
          currentState: res.currentState,
        };
      }
      committed = {
        sessionId: req.sessionId,
        state: res.state,
        version: res.version,
        producedBy: operationId,
      };
    }
  }

  // 7. Trajectory append, derived from the authoritative commit and keyed by operationId.
  const step: Step = {
    stepIndex: req.stepIndex,
    action: req.label,
    input: { operationId, actorId: req.actor.actorId, ...(req.stepInput ?? {}) },
    output: {
      ...(committed ? { version: committed.version } : {}),
      ...(req.stepOutput ?? {}),
    },
    cost: req.cost,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    boundary: context.boundary,
    operationId: context.operationId,
    proposalId: context.proposalId,
    actor: context.actor,
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
  };
  const record = await req.trajectoryStore.addStep(req.trajectoryId, step);

  // 8. Emit.
  req.emit?.({
    type: "state-change",
    sessionId: req.sessionId,
    operationId: context.operationId,
    trajectoryId: req.trajectoryId,
    stepIndex: step.stepIndex,
    proposalId: context.proposalId,
    actor: context.actor,
    boundary: context.boundary,
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
    intent: req.eventIntent ?? "commit",
    at: step.timestamp,
  });

  return {
    tier,
    context,
    committed,
    step,
    trajectory: record?.trajectory ?? null,
  };
}

export * from "./risk";

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. Both stores are parameters, never singletons. Importing a store accessor here would
//    close the cycle this module exists to open. Adapters resolve the singleton and pass it.
//
// 2. computeNextState === null is a real case, not an omission: a read-only tool commits no
//    managed state and still gets exactly one trajectory step (ADR-029 invariant 1).
//
// 3. Stage order is the contract. Gating before commit, commit before trajectory append,
//    nothing at all on a lost CAS. Reordering these breaks guarantees, not just tests.
