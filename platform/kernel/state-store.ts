/**
 * platform/kernel/state-store.ts — Application state store contract
 *
 * The ActivityStateStore is registry slot #14 (ADR-028 D2). It persists VERSIONED
 * STATE ONLY and is the authoritative system of record. Trajectory persistence is
 * NOT here — it is reused from platform/agents, written idempotently by the
 * SessionService coordinator.
 *
 * ATOMICITY IS A CONTRACT, NOT A DATABASE FEATURE (D5). Because the store is a
 * swappable provider, the concurrency guarantee lives in this interface — every
 * implementation must provide atomic conditional-commit (CAS) and atomic
 * reduce-commit (RMW), verified by the conformance kit racing concurrent commits.
 * A store that cannot provide these is not a valid state store.
 *
 * ── State Provider Authoring Checklist (ADR-028) ──────────────────────
 *  1. Implement load / commit (atomic CAS) / reduceCommit (atomic RMW) / create / delete.
 *  2. Persist TState opaquely (JSON-serializable); keep version monotonic.
 *  3. Provide the atomicity primitive — native atomic conditional write
 *     (Postgres UPDATE ... WHERE version=N; Redis WATCH/MULTI/EXEC or Lua;
 *     DynamoDB ConditionExpression; in-memory check-and-set). No atomic
 *     conditional write ⇒ not a valid store.
 *  4. Register the slot in platform/providers/registry.ts (ProviderSelections,
 *     init fn, initProviders(), env var, memory fallback + warn).
 *  5. Add the conformance kit arm — MUST include concurrency tests (concurrent CAS:
 *     exactly one wins; reduceCommit associativity; conflict-result shape).
 *  6. Add the migration (persistent stores) — state table carrying the action that
 *     produced each version (reconstructible-state guarantee).
 *  7. Test failure modes (missing config → fallback + warn; unreachable → surfaced
 *     error; conflict → well-formed result, not exception).
 *  8. Wire delete to GDPR hard-purge.
 *  9. Update ADR-028 providers table + README + this checklist.
 * 10. Run the full kit + a manual concurrent-commit smoke for persistent stores.
 *
 * GenAI Principles: P4 (structural safety — atomicity enforced), P7 (provider-aware),
 * P8 (context/state), P18 (durable, versioned state).
 *
 * @module platform/kernel
 */

import type { CommitResult, SessionMeta, VersionedState } from "./types";

/**
 * A pure reducer applied atomically against the latest state (D5). Used for
 * commutative/contended actions so concurrent updates compose without a version
 * conflict. Must be associative + commutative; the framework trusts the declaration
 * (a wrong declaration corrupts only that consumer's own state).
 */
export type StateReducer<TState> = (current: TState) => TState;

/**
 * The contract every application state store implements. Generic over the domain's
 * TState, which is persisted opaquely.
 */
export interface ActivityStateStore<TState> {
  /**
   * Create initial state for a new session at version 1. Fails if the session
   * already exists.
   */
  create(sessionId: string, initialState: TState): Promise<VersionedState<TState>>;

  /** Load current versioned state, or null if the session does not exist. */
  load(sessionId: string): Promise<VersionedState<TState> | null>;

  /**
   * Atomic conditional commit (CAS). Commits `newState` iff the stored version
   * equals `expectedVersion`; otherwise returns the current version + state so the
   * caller can revalidate. MUST be atomic: two commits racing at the same
   * expectedVersion → exactly one returns ok:true (D5). `producedBy` records the
   * action id for the reconstructible-state guarantee (D2).
   */
  commit(
    sessionId: string,
    expectedVersion: number,
    newState: TState,
    producedBy: string
  ): Promise<CommitResult<TState>>;

  /**
   * Atomic read-modify-write for commutative/contended actions (D5). Applies
   * `reducer` against the latest state and commits, without a version precondition.
   * MUST be atomic: concurrent reduceCommits compose without loss. Returns the
   * post-merge versioned state.
   */
  reduceCommit(
    sessionId: string,
    reducer: StateReducer<TState>,
    producedBy: string
  ): Promise<VersionedState<TState>>;

  /**
   * Persist the session's non-state metadata (TASK-071).
   *
   * Optional on the interface: a store that cannot carry meta is still a valid state store,
   * and loadSession reports the absence rather than failing. Separate from commit() because
   * meta moves on a different cadence — participants change rarely, state every action, and
   * versioning them together would make a participant change contend with a state commit.
   */
  saveMeta?(sessionId: string, meta: SessionMeta): Promise<void>;

  /** Read the session's metadata, or null when absent. */
  loadMeta?(sessionId: string): Promise<SessionMeta | null>;

  /** Hard-purge all state for a session (GDPR / lifecycle, D2 checklist step 8). */
  delete(sessionId: string): Promise<void>;
}
