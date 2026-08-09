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

import type { AgentIdentity, BudgetConfig } from "@/platform/agents/types";
import { generateSecureId } from "@/platform/agents/utils";
import { getTrajectoryStore } from "@/platform/agents";
import {
  executeActionPipeline,
  repairSession,
  type RepairOutcome,
  isPipelineConflict,
  PipelineRejectedError,
} from "@/platform/action-pipeline";
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
  const turn = turnBased
    ? {
        order: participants.map((p) => p.actorId),
        currentIndex: 0,
        turnNumber: 1,
      }
    : undefined;

  // Persisted so the session can be reconstructed later (TASK-071). Without it,
  // state exists and the session shape does not.
  if (store.saveMeta) {
    await store.saveMeta(sessionId, {
      definitionId: definition.id,
      status: "active",
      capabilities: definition.capabilities as readonly Capability[],
      participants,
      budget,
      turn,
    });
  }

  return {
    sessionId,
    definitionId: definition.id,
    status: "active",
    capabilities: definition.capabilities as readonly Capability[],
    participants,
    current,
    trajectory: record.trajectory,
    budget,
    turn,
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
  /**
   * ADR-031 D1: supply this to make the call a retry of an existing logical action. When
   * absent the pipeline mints one, which is the behaviour every current caller gets.
   *
   * A caller wanting retry safety must mint-and-retain before its first attempt — a
   * coordinator-minted-only identity makes every retry a new action by construction, which
   * is why the D4 dedup guarantees were unreachable through this API before now.
   */
  readonly operationId?: string;
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

  // ── Session-specific checks. These belong to the adapter, not the pipeline: an agent
  // ── tool call has no turn order and no ActivityDefinition to validate against.

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

  // Domain policy (D1 — the definition owns validity)
  if (!definition.validateAction(session.current.state, action)) {
    throw new ActionRejectedError(
      `action ${action.type} invalid for current state`,
      "invalid-action"
    );
  }

  // ── The governed sequence, shared with every other adapter (ADR-029 D2).
  let outcome;
  try {
    outcome = await executeActionPipeline<TState>({
      spec,
      actor,
      sessionId: session.sessionId,
      operationId: args.operationId,
      label: action.type,
      cost,
      boundary: "commitment",
      stateStore: getActivityStateStore<TState>(),
      trajectoryStore: getTrajectoryStore(),
      trajectoryId: session.trajectory.trajectoryId,
      stepIndex: session.trajectory.steps.length,
      expectedVersion: session.current.version,
      computeNextState: () => definition.applyAction(session.current.state, action),
      budgetCeiling: session.budget?.maxCostPerTrajectory,
      ceilingLabel: "session ceiling",
      emit,
    });
  } catch (err) {
    // The pipeline's vocabulary is translated into the session's, so consumers keep the
    // one error type they already catch.
    if (err instanceof PipelineRejectedError) {
      throw new ActionRejectedError(err.message, err.reason);
    }
    throw err;
  }

  if (isPipelineConflict(outcome)) {
    return {
      conflict: true,
      currentVersion: outcome.currentVersion,
      currentState: outcome.currentState,
    };
  }

  // Ephemeral: state advanced in memory, nothing persisted (D3 tier semantics).
  if (outcome.tier === "ephemeral") {
    const next = definition.applyAction(session.current.state, action);
    return {
      result: { ...session.current, state: next },
      trajectory: session.trajectory,
      nextActions: enumerateNextActions(definition, next, args.options),
      cost,
    };
  }

  const committed = outcome.committed as VersionedState<TState>;
  return {
    result: committed,
    trajectory: outcome.trajectory ?? session.trajectory,
    nextActions: enumerateNextActions(definition, committed.state, args.options),
    cost,
  };
}

// ── Session load (TASK-071, ADR-031 D6) ───────────────────────────────

export interface LoadSessionArgs<TState, TAction, TConfig> {
  readonly sessionId: string;
  /**
   * The definition is supplied rather than persisted: it carries functions
   * (initialState, validateAction, applyAction) that cannot be serialised. Only its ID is
   * stored, and it is checked against the loaded meta.
   */
  readonly definition: ActivityDefinition<TState, TAction, TConfig>;
  readonly actor: AgentIdentity;
  /** Skip the D6 repair check. Only for tests that assert the unrepaired state. */
  readonly skipRepair?: boolean;
}

export interface LoadedSession<TState, TAction> {
  readonly session: ActivitySession<TState, TAction>;
  /** What the D6 repair found. Absent when repair was skipped. */
  readonly repair?: RepairOutcome;
}

/**
 * Reconstruct a session from its id, and complete any interrupted operation before handing
 * it back (ADR-031 D6).
 *
 * The framework could create a session and never resume one. That is why repairSession had
 * no caller: the ADR places repair "on session load", and there was no load path. This is
 * that path.
 *
 * Returns null when the session does not exist. Throws when it exists but its metadata does
 * not — that combination means the state was written by something that did not persist meta,
 * and silently inventing participants would be worse than refusing.
 */
export async function loadSession<TState, TAction, TConfig>(
  args: LoadSessionArgs<TState, TAction, TConfig>
): Promise<LoadedSession<TState, TAction> | null> {
  const store = getActivityStateStore<TState>();
  const current = await store.load(args.sessionId);
  if (!current) return null;

  if (!store.loadMeta) {
    throw new Error(
      `app-framework: the active state store cannot load session metadata; ` +
        `${args.sessionId} cannot be reconstructed`
    );
  }
  const meta = await store.loadMeta(args.sessionId);
  if (!meta) {
    throw new Error(
      `app-framework: no metadata for session ${args.sessionId}. State exists but the ` +
        `session shape does not — it was written before migration 029, or by a path that ` +
        `does not persist meta.`
    );
  }
  if (meta.definitionId !== args.definition.id) {
    throw new Error(
      `app-framework: session ${args.sessionId} belongs to definition ` +
        `${meta.definitionId}, not ${args.definition.id}`
    );
  }

  const trajectories = await getTrajectoryStore().query({
    subjectKind: "session",
    subjectId: args.sessionId,
    limit: 1,
  });
  const record = trajectories[0];
  if (!record) {
    throw new Error(`app-framework: no trajectory for session ${args.sessionId}`);
  }

  let repair: RepairOutcome | undefined;
  if (!args.skipRepair) {
    // The crash window: state committed, process died before the trajectory append. This is
    // the only place that window is closed automatically.
    repair = await repairSession<TState>({
      sessionId: args.sessionId,
      trajectoryId: record.trajectory.trajectoryId,
      actor: args.actor,
      stateStore: store,
      trajectoryStore: getTrajectoryStore(),
      emit,
    });
  }

  const refreshed = repair?.repaired
    ? await getTrajectoryStore().getById(record.trajectory.trajectoryId)
    : record;

  return {
    session: {
      sessionId: args.sessionId,
      definitionId: meta.definitionId,
      status: meta.status,
      capabilities: meta.capabilities,
      participants: meta.participants,
      current,
      trajectory: (refreshed ?? record).trajectory,
      budget: meta.budget,
      turn: meta.turn,
    },
    repair,
  };
}

/**
 * Persist a session's metadata after it changes.
 *
 * Needed because dispatch() checks turn order and does not advance it — advancement lives in
 * turn.ts and is the caller's, so the caller must persist afterwards or the stored turn goes
 * stale. TASK-072 records that this belongs in the coordinator.
 */
export async function updateSessionMeta<TState, TAction>(
  session: ActivitySession<TState, TAction>
): Promise<void> {
  const store = getActivityStateStore<TState>();
  if (!store.saveMeta) return;
  await store.saveMeta(session.sessionId, {
    definitionId: session.definitionId,
    status: session.status,
    capabilities: session.capabilities,
    participants: session.participants,
    budget: session.budget,
    turn: session.turn,
  });
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
// 1. operationId is minted by the pipeline when absent, and MAY be supplied by a caller
//    (ADR-031 D1). This reverses the Sprint 1 rule: without a caller-supplied id every
//    retry is a new logical action, so the D4 per-edge dedup guarantees could not be
//    expressed through the public API. Supplying one asserts "this is that same action".
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
