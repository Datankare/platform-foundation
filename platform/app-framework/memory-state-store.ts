/**
 * platform/app-framework/memory-state-store.ts — In-memory state store
 *
 * Reference ActivityStateStore implementation (ADR-028 D2). The default for tests and
 * for the "memory" registry-slot value. Atomicity (D5) is trivially satisfied: Node is
 * single-threaded, so the read-check-set in commit() and the read-modify-write in
 * reduceCommit() cannot interleave — no lock needed. Persistent stores must reproduce
 * this atomicity with a native conditional-write primitive (see state-store.ts checklist).
 *
 * @module platform/app-framework
 */

import type { ActivityStateStore, StateReducer } from "./state-store";
import type { CommitResult, VersionedState } from "./types";

interface Entry<TState> {
  state: TState;
  version: number;
  producedBy?: string;
}

export class InMemoryActivityStateStore<TState> implements ActivityStateStore<TState> {
  private readonly store = new Map<string, Entry<TState>>();

  async create(sessionId: string, initialState: TState): Promise<VersionedState<TState>> {
    if (this.store.has(sessionId)) {
      throw new Error(`app-framework: session already exists: ${sessionId}`);
    }
    this.store.set(sessionId, { state: initialState, version: 1 });
    return { sessionId, state: initialState, version: 1 };
  }

  async load(sessionId: string): Promise<VersionedState<TState> | null> {
    const entry = this.store.get(sessionId);
    if (!entry) return null;
    return {
      sessionId,
      state: entry.state,
      version: entry.version,
      producedBy: entry.producedBy,
    };
  }

  async commit(
    sessionId: string,
    expectedVersion: number,
    newState: TState,
    producedBy: string
  ): Promise<CommitResult<TState>> {
    // Read-check-set — atomic in single-threaded Node (no await between check and set).
    const entry = this.store.get(sessionId);
    if (!entry) {
      throw new Error(`app-framework: session not found: ${sessionId}`);
    }
    if (entry.version !== expectedVersion) {
      return { ok: false, currentVersion: entry.version, currentState: entry.state };
    }
    const version = entry.version + 1;
    this.store.set(sessionId, { state: newState, version, producedBy });
    return { ok: true, version, state: newState };
  }

  async reduceCommit(
    sessionId: string,
    reducer: StateReducer<TState>,
    producedBy: string
  ): Promise<VersionedState<TState>> {
    // Read-modify-write against latest — atomic in single-threaded Node.
    const entry = this.store.get(sessionId);
    if (!entry) {
      throw new Error(`app-framework: session not found: ${sessionId}`);
    }
    const state = reducer(entry.state);
    const version = entry.version + 1;
    this.store.set(sessionId, { state, version, producedBy });
    return { sessionId, state, version, producedBy };
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. Atomicity here relies on Node being single-threaded: there is NO await between
//    reading `entry` and writing the new state in commit()/reduceCommit(). Do not
//    introduce an await in that window — it would open a race the persistent stores
//    close with a DB conditional write.
//
// 2. This store holds references, not deep copies. Callers must treat TState as
//    immutable (produce new state, never mutate in place) — consistent with the
//    readonly discipline in types.ts and the pure applyAction hook (D9).
