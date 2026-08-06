/**
 * platform/app-framework/supabase-state-store.ts — Supabase-backed state store
 *
 * Persistent ActivityStateStore (ADR-028 D2). Atomicity (D5) is provided by Postgres:
 *   - commit(): UPDATE ... WHERE id=$ AND version=$expected  → 0 rows updated = conflict.
 *   - reduceCommit(): read-apply-CAS retry loop (bounded); the CAS makes each attempt atomic.
 * Table: app_sessions (migration 018), columns id / state jsonb / version int / produced_by /
 * created_at / updated_at. `state` and `produced_by` give the reconstructible-state guarantee.
 *
 * @module platform/app-framework
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ActivityStateStore, StateReducer } from "./state-store";
import type { CommitResult, SessionMeta, VersionedState } from "./types";

const TABLE = "app_sessions";
const MAX_REDUCE_RETRIES = 10;

interface Row {
  id: string;
  state: unknown;
  version: number;
  produced_by: string | null;
}

export class SupabaseActivityStateStore<TState> implements ActivityStateStore<TState> {
  private readonly db: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false } });
  }

  async create(sessionId: string, initialState: TState): Promise<VersionedState<TState>> {
    const { error } = await this.db
      .from(TABLE)
      .insert({ id: sessionId, state: initialState, version: 1 });
    if (error) {
      throw new Error(`app-framework: create failed for ${sessionId}: ${error.message}`);
    }
    return { sessionId, state: initialState, version: 1 };
  }

  async load(sessionId: string): Promise<VersionedState<TState> | null> {
    const { data, error } = await this.db
      .from(TABLE)
      .select("id, state, version, produced_by")
      .eq("id", sessionId)
      .maybeSingle<Row>();
    if (error) {
      throw new Error(`app-framework: load failed for ${sessionId}: ${error.message}`);
    }
    if (!data) return null;
    return {
      sessionId,
      state: data.state as TState,
      version: data.version,
      producedBy: data.produced_by ?? undefined,
    };
  }

  async commit(
    sessionId: string,
    expectedVersion: number,
    newState: TState,
    producedBy: string
  ): Promise<CommitResult<TState>> {
    // Atomic CAS: update only if version still matches. Returns the row iff it won.
    const { data, error } = await this.db
      .from(TABLE)
      .update({
        state: newState,
        version: expectedVersion + 1,
        produced_by: producedBy,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId)
      .eq("version", expectedVersion)
      .select("id, state, version, produced_by")
      .maybeSingle<Row>();

    if (error) {
      throw new Error(`app-framework: commit failed for ${sessionId}: ${error.message}`);
    }
    if (data) {
      return { ok: true, version: data.version, state: data.state as TState };
    }
    // 0 rows updated → conflict. Re-read current for the caller.
    const current = await this.load(sessionId);
    if (!current) {
      throw new Error(`app-framework: session not found on conflict: ${sessionId}`);
    }
    return { ok: false, currentVersion: current.version, currentState: current.state };
  }

  async reduceCommit(
    sessionId: string,
    reducer: StateReducer<TState>,
    producedBy: string
  ): Promise<VersionedState<TState>> {
    // Read → apply → CAS, retrying on conflict. Each attempt is atomic via the CAS.
    for (let attempt = 0; attempt < MAX_REDUCE_RETRIES; attempt++) {
      const current = await this.load(sessionId);
      if (!current) {
        throw new Error(`app-framework: session not found: ${sessionId}`);
      }
      const next = reducer(current.state);
      const res = await this.commit(sessionId, current.version, next, producedBy);
      if (res.ok) {
        return { sessionId, state: res.state, version: res.version, producedBy };
      }
    }
    throw new Error(
      `app-framework: reduceCommit exhausted ${MAX_REDUCE_RETRIES} retries for ${sessionId}`
    );
  }

  async saveMeta(sessionId: string, meta: SessionMeta): Promise<void> {
    // Deliberately NOT version-guarded: meta moves on a different cadence than state, and
    // making a participant change contend with a state commit would be a conflict nobody
    // asked for.
    const { error } = await this.db
      .from(TABLE)
      .update({ meta, updated_at: new Date().toISOString() })
      .eq("id", sessionId);
    if (error) {
      throw new Error(
        `app-framework: saveMeta failed for ${sessionId}: ${error.message}`
      );
    }
  }

  async loadMeta(sessionId: string): Promise<SessionMeta | null> {
    const { data, error } = await this.db
      .from(TABLE)
      .select("meta")
      .eq("id", sessionId)
      .maybeSingle<{ meta: unknown }>();
    if (error) {
      throw new Error(
        `app-framework: loadMeta failed for ${sessionId}: ${error.message}`
      );
    }
    const meta = data?.meta;
    if (!meta || typeof meta !== "object" || !Object.keys(meta).length) return null;
    return meta as SessionMeta;
  }

  async delete(sessionId: string): Promise<void> {
    const { error } = await this.db.from(TABLE).delete().eq("id", sessionId);
    if (error) {
      throw new Error(`app-framework: delete failed for ${sessionId}: ${error.message}`);
    }
  }
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. commit() atomicity is the `.eq("version", expectedVersion)` on the UPDATE — Postgres
//    updates 0 rows if the version moved. Do NOT split this into read-then-update; that
//    reopens the race the CAS closes.
//
// 2. reduceCommit() uses commit()'s CAS in a bounded retry loop. It is NOT lock-free-forever;
//    under extreme contention it can exhaust retries and throw. That is the correct failure
//    (surfaced, not silent) — a true hotspot needs the commutative-reducer path at the DB
//    level, which is the deferred pessimistic-locking trigger (ADR-028 D5).
