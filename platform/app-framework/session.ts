/**
 * platform/app-framework/session.ts — SessionService (the coordinator)
 *
 * The heart of the application framework (ADR-028). Owns the two-store workflow (D2):
 * validate → commit state (authoritative, CAS) → append trajectory step (idempotent) →
 * emit event (D8). Consumers call one method; they never touch two stores, never mint
 * an operationId, and never construct an ActionContext.
 *
 * GenAI Principles: P2 (bounded execution), P4 (structural safety — risk computed here,
 * not accepted from callers), P12 (cost + budget), P15 (identity/lineage in every action),
 * P17 (cognition/commitment boundary), P18 (durable trajectory per action).
 *
 * @module platform/app-framework
 */

import type { AgentIdentity, BudgetConfig, Step } from "@/platform/agents/types";
import { generateSecureId } from "@/platform/agents/utils";
import { getTrajectoryStore } from "@/platform/agents";
import { assembleActionContext, computeEffectiveRisk, resolveTier } from "./actions";
import { getActivityStateStore } from "./index";
import type {
  Action,
  ActionResult,
  ActionSpec,
  ActivityDefinition,
  ActivitySession,
  Capability,
  DispatchOptions,
  SessionEvent,
  SessionEventSubscriber,
  VersionedState,
} from "./types";

// ── Event subscribers (D8) ────────────────────────────────────────────

const subscribers: SessionEventSubscriber[] = [];

/** Subscribe to the session event stream. Returns an unsubscribe function (D8). */
export function subscribeSessionEvents(fn: SessionEventSubscriber): () => void {
  subscribers.push(fn);
  return () => {
    const i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

/** Remove all subscribers (testing only). */
export function resetSessionEventSubscribers(): void {
  subscribers.length = 0;
}

function emit(event: SessionEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      /* justified */
      // A failing subscriber must not break the session mutation (D8 — subscribers are
      // observers, not participants). Errors are contained.
    }
  }
}

// ── Errors ────────────────────────────────────────────────────────────

/** Raised when an action is rejected before any state mutation. */
export class ActionRejectedError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "invalid-action"
      | "unknown-action"
      | "not-your-turn"
      | "budget-exceeded"
      | "requires-approval"
  ) {
    super(message);
    this.name = "ActionRejectedError";
  }
}

// ── Conflict result (D5) ──────────────────────────────────────────────

/** Returned when a commit loses the CAS race — carries fresh state for revalidation. */
export interface ConflictResult<TState> {
  readonly conflict: true;
  readonly currentVersion: number;
  readonly currentState: TState;
}

export type DispatchOutcome<TState> = ActionResult<TState> | ConflictResult<TState>;

/** Type guard: did the dispatch lose the version race? */
export function isConflict<TState>(
  outcome: DispatchOutcome<TState>
): outcome is ConflictResult<TState> {
  return (outcome as ConflictResult<TState>).conflict === true;
}

// ── Session creation ──────────────────────────────────────────────────

export interface CreateSessionArgs<TState, TAction, TConfig> {
  readonly definition: ActivityDefinition<TState, TAction, TConfig>;
  readonly config: TConfig;
  readonly participants: readonly AgentIdentity[];
  /** Optional ceiling; absent = unbounded (D10). */
  readonly budget?: BudgetConfig;
  readonly sessionId?: string;
}

/**
 * Create a session: initial state via the definition's pure hook, persisted at v1, with
 * a trajectory opened for its history (D4). Turn state initialized iff turn-based (D6).
 */
export async function createSession<TState, TAction, TConfig>(
  args: CreateSessionArgs<TState, TAction, TConfig>
): Promise<ActivitySession<TState, TAction>> {
  const { definition, config, participants, budget } = args;
  // 128-bit: sessionId gates access to session state (P4).
  const sessionId = args.sessionId ?? `sess_${generateSecureId()}`;

  const store = getActivityStateStore<TState>();
  const initial = definition.initialState(config);
  const current = await store.create(sessionId, initial);

  const record = await getTrajectoryStore().create(
    { kind: "session", id: sessionId },
    "session-created",
    "user"
  );

  const turnBased = definition.capabilities.includes("turn-based");

  return {
    sessionId,
    definitionId: definition.id,
    status: "active",
    capabilities: definition.capabilities as readonly Capability[],
    participants,
    current,
    trajectory: record.trajectory,
    budget,
    turn: turnBased
      ? {
          order: participants.map((p) => p.actorId),
          currentIndex: 0,
          turnNumber: 1,
        }
      : undefined,
  };
}

// ── Dispatch (the coordinator sequence) ───────────────────────────────

export interface DispatchArgs<TState, TAction, TConfig> {
  readonly session: ActivitySession<TState, TAction>;
  readonly definition: ActivityDefinition<TState, TAction, TConfig>;
  readonly action: Action<TAction>;
  readonly actor: AgentIdentity;
  /** Cost incurred by this action in USD (0 for rule-based) — charged against budget (D10). */
  readonly cost?: number;
  readonly options?: DispatchOptions;
}

/**
 * Dispatch an action. Sequence (D2 coordinator):
 *   1. resolve the ActionSpec + compute effectiveRisk (D3 — never trust the caller)
 *   2. gate: two-phase actions cannot direct-commit (D3)
 *   3. turn check (D6), budget check (D10), domain validation (D1 policy hook)
 *   4. commit state via CAS (D5) — on conflict, return fresh state, mutate nothing
 *   5. append trajectory step keyed by operationId (D4, idempotent)
 *   6. emit SessionEvent (D8)
 *   7. return the AUX shape (D7)
 */
export async function dispatch<TState, TAction, TConfig>(
  args: DispatchArgs<TState, TAction, TConfig>
): Promise<DispatchOutcome<TState>> {
  const { session, definition, action, actor } = args;
  const cost = args.cost ?? 0;

  const spec = definition.actions.find((a) => a.type === action.type);
  if (!spec) {
    throw new ActionRejectedError(
      `unknown action type: ${action.type}`,
      "unknown-action"
    );
  }

  const tier = resolveTier(spec);
  if (tier === "two-phase") {
    throw new ActionRejectedError(
      `action ${action.type} requires approval (effectiveRisk=${computeEffectiveRisk(spec)}) — use propose/approve (ADR-031)`,
      "requires-approval"
    );
  }

  // Turn enforcement (D6 core)
  if (session.turn) {
    const expected = session.turn.order[session.turn.currentIndex];
    if (expected !== actor.actorId) {
      throw new ActionRejectedError(
        `not ${actor.actorId}'s turn (expected ${expected})`,
        "not-your-turn"
      );
    }
  }

  // Budget: most-restrictive-wins (D10). Session ceiling checked here; agent-scope
  // ceilings are enforced by the agents BudgetTracker on the agent path.
  if (session.budget && cost > session.budget.maxCostPerTrajectory) {
    throw new ActionRejectedError(
      `cost ${cost} exceeds session ceiling ${session.budget.maxCostPerTrajectory}`,
      "budget-exceeded"
    );
  }

  // Domain policy (D1 — the definition owns validity)
  if (!definition.validateAction(session.current.state, action)) {
    throw new ActionRejectedError(
      `action ${action.type} invalid for current state`,
      "invalid-action"
    );
  }

  // 128-bit: operationId is the audit + idempotency key (ADR-028 D3, ADR-031).
  const operationId = `op_${generateSecureId()}`;

  // Ephemeral actions never touch durable state (D3 invariant) — no commit, no trajectory.
  if (tier === "ephemeral") {
    const next = definition.applyAction(session.current.state, action);
    return {
      result: { ...session.current, state: next },
      trajectory: session.trajectory,
      nextActions: enumerateNextActions(definition, next, args.options),
      cost,
    };
  }

  // ADR-031 D9: the assembled context is the justification record for this action and is
  // carried into the trajectory step and the emitted event. Previously this call was made
  // for effect and its result discarded — and the function is pure, so the whole call was a
  // no-op that computed effectiveRisk and threw it away.
  const context = assembleActionContext({
    spec,
    actor,
    sessionId: session.sessionId,
    operationId,
    boundary: "commitment",
  });

  const nextState = definition.applyAction(session.current.state, action);
  const store = getActivityStateStore<TState>();

  // Commutative actions bypass the version precondition (D5 hotspot path).
  let committed: VersionedState<TState>;
  if (spec.commutative) {
    committed = await store.reduceCommit(session.sessionId, () => nextState, operationId);
  } else {
    const res = await store.commit(
      session.sessionId,
      session.current.version,
      nextState,
      operationId
    );
    if (!res.ok) {
      return {
        conflict: true,
        currentVersion: res.currentVersion,
        currentState: res.currentState,
      };
    }
    committed = {
      sessionId: session.sessionId,
      state: res.state,
      version: res.version,
      producedBy: operationId,
    };
  }

  // Trajectory append — derived from the authoritative commit, idempotent by operationId (D4).
  const step: Step = {
    stepIndex: session.trajectory.steps.length,
    action: action.type,
    input: { operationId, actorId: actor.actorId },
    output: { version: committed.version },
    cost,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    boundary: context.boundary,
    operationId: context.operationId,
    proposalId: context.proposalId,
    actor: context.actor,
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
  };
  const record = await getTrajectoryStore().addStep(
    session.trajectory.trajectoryId,
    step
  );

  emit({
    type: "state-change",
    sessionId: session.sessionId,
    operationId: context.operationId,
    trajectoryId: session.trajectory.trajectoryId,
    stepIndex: step.stepIndex,
    proposalId: context.proposalId,
    actor: context.actor,
    boundary: context.boundary,
    effects: context.effects,
    effectiveRisk: context.effectiveRisk,
    intent: "commit",
    at: step.timestamp,
  });

  return {
    result: committed,
    trajectory: record?.trajectory ?? session.trajectory,
    nextActions: enumerateNextActions(definition, committed.state, args.options),
    cost,
  };
}

// ── AUX affordances (D7) ──────────────────────────────────────────────

/**
 * Synchronous filter over the declared action schema — no LLM call, no I/O. Skipped
 * when the caller opts out on a hot path (D7 Flavor 2).
 */
function enumerateNextActions<TState, TAction, TConfig>(
  definition: ActivityDefinition<TState, TAction, TConfig>,
  state: TState,
  options?: DispatchOptions
): readonly string[] {
  if (options?.computeNextActions === false) return [];
  return definition.actions
    .filter((spec: ActionSpec) =>
      definition.validateAction(state, { type: spec.type, payload: undefined as TAction })
    )
    .map((spec) => spec.type);
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. operationId is minted HERE, never by a consumer (D3). Do not accept one as an argument.
//
// 2. On CAS conflict the function returns a ConflictResult and mutates NOTHING — no
//    trajectory append, no event. Use isConflict() to branch; do not auto-retry (D5).
//
// 3. enumerateNextActions calls validateAction with an undefined payload — definitions
//    must tolerate a payload-less probe when reporting affordances. Document this in the
//    ActivityDefinition contract if a domain needs payload-sensitive affordances.
//
// 4. Ephemeral actions return an un-persisted VersionedState (state advanced, version
//    unchanged). Callers must not treat it as committed (D3 tier semantics).
