/**
 * platform/app-framework/supabase-state-store.ts — Supabase-backed state store
 *
 * Persistent ActivityStateStore (ADR-028 D2), on raw fetch against /rest/v1/ — NOT the
 * Supabase JS client.
 *
 * That transport choice closes TASK-066, and the reason is not stylistic. A conformance kit
 * fakes `global.fetch` to run the real store against an in-memory PostgREST; it cannot
 * intercept the JS client. So this store — the only one built on createClient — was the only
 * registry slot with no Supabase arm, which is why it shipped in Sprint 1 against a table
 * that did not exist and stayed dead for a full sprint behind a green gate. On raw fetch it
 * is exercisable exactly as its six siblings are.
 *
 * Atomicity (D5) is Postgres's:
 *   commit()        PATCH ?id=eq.X&version=eq.N — zero rows returned is the conflict
 *   reduceCommit()  read-apply-CAS retry loop; each attempt is atomic via that CAS
 *
 * Table: app_sessions — id / state jsonb / version int / produced_by / meta jsonb (029).
 *
 * @module platform/app-framework
 */

import type { ActivityStateStore, StateReducer } from "./state-store";
import type { CommitResult, SessionMeta, VersionedState } from "./types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const TABLE = "app_sessions";

/**
 * The conformance kit races ten concurrent reduceCommit calls, and a loser can lose up to
 * nine times before winning. Ten retries was exactly that bound — fine when the store is
 * synchronous, at the edge against a real transport where every attempt yields.
 */
const MAX_REDUCE_RETRIES = 25;

interface Row {
  id: string;
  state: unknown;
  version: number;
  produced_by: string | null;
  meta?: unknown;
}

function headers(key: string, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

export class SupabaseActivityStateStore<TState> implements ActivityStateStore<TState> {
  private readonly url: string;
  private readonly key: string;

  constructor(url: string, serviceKey: string) {
    this.url = url.replace(/\/+$/, "");
    this.key = serviceKey;
  }

  private endpoint(query = ""): string {
    return `${this.url}/rest/v1/${TABLE}${query}`;
  }

  private async rows(query: string): Promise<Row[]> {
    const res = await fetchWithTimeout(this.endpoint(query), {
      timeoutMs: 10_000,
      // Retry is the caller's: reduceCommit loops on version conflict and the effect
      // ledger owns at-most-once. A transport retrying a PATCH underneath either can
      // double-apply a committed write (ADR-028 D5, ADR-031 D7).
      maxRetries: 0,
      method: "GET",
      headers: headers(this.key),
    });
    if (!res.ok) {
      throw new Error(`app-framework: read failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as Row[];
  }

  async create(sessionId: string, initialState: TState): Promise<VersionedState<TState>> {
    const res = await fetchWithTimeout(this.endpoint(), {
      timeoutMs: 10_000,
      // Retry is the caller's: reduceCommit loops on version conflict and the effect
      // ledger owns at-most-once. A transport retrying a PATCH underneath either can
      // double-apply a committed write (ADR-028 D5, ADR-031 D7).
      maxRetries: 0,
      method: "POST",
      headers: headers(this.key, "return=representation"),
      body: JSON.stringify({ id: sessionId, state: initialState, version: 1, meta: {} }),
    });
    if (!res.ok) {
      // A duplicate id surfaces as a primary-key violation. Creating over an existing
      // session would silently discard its state and its history.
      throw new Error(
        `app-framework: create failed for ${sessionId} (${res.status}): ${await res.text()}`
      );
    }
    return { sessionId, state: initialState, version: 1 };
  }

  async load(sessionId: string): Promise<VersionedState<TState> | null> {
    const rows = await this.rows(
      `?id=eq.${encodeURIComponent(sessionId)}&select=id,state,version,produced_by`
    );
    if (!rows.length) return null;
    return {
      sessionId,
      state: rows[0].state as TState,
      version: rows[0].version,
      producedBy: rows[0].produced_by ?? undefined,
    };
  }

  async commit(
    sessionId: string,
    expectedVersion: number,
    newState: TState,
    producedBy: string
  ): Promise<CommitResult<TState>> {
    // The CAS: the version filter is part of the query, so a moved version matches no row.
    // Do NOT split this into read-then-update — that reopens the race it closes.
    const res = await fetchWithTimeout(
      this.endpoint(
        `?id=eq.${encodeURIComponent(sessionId)}&version=eq.${expectedVersion}`
      ),
      {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        method: "PATCH",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({
          state: newState,
          version: expectedVersion + 1,
          produced_by: producedBy,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `app-framework: commit failed for ${sessionId} (${res.status}): ${await res.text()}`
      );
    }
    const updated = (await res.json()) as Row[];
    if (updated.length) {
      return { ok: true, version: updated[0].version, state: updated[0].state as TState };
    }
    // Zero rows: someone else moved the version. Re-read so the caller can rebase.
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
    for (let attempt = 0; attempt < MAX_REDUCE_RETRIES; attempt++) {
      const current = await this.load(sessionId);
      if (!current) {
        throw new Error(`app-framework: session not found: ${sessionId}`);
      }
      const res = await this.commit(
        sessionId,
        current.version,
        reducer(current.state),
        producedBy
      );
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
    const res = await fetchWithTimeout(
      this.endpoint(`?id=eq.${encodeURIComponent(sessionId)}`),
      {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        method: "PATCH",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({ meta, updated_at: new Date().toISOString() }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `app-framework: saveMeta failed for ${sessionId} (${res.status}): ${await res.text()}`
      );
    }
  }

  async loadMeta(sessionId: string): Promise<SessionMeta | null> {
    const rows = await this.rows(`?id=eq.${encodeURIComponent(sessionId)}&select=meta`);
    const meta = rows[0]?.meta;
    if (!meta || typeof meta !== "object" || !Object.keys(meta).length) return null;
    return meta as SessionMeta;
  }

  async delete(sessionId: string): Promise<void> {
    const res = await fetchWithTimeout(
      this.endpoint(`?id=eq.${encodeURIComponent(sessionId)}`),
      {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        method: "DELETE",
        headers: headers(this.key),
      }
    );
    if (!res.ok) {
      throw new Error(
        `app-framework: delete failed for ${sessionId} (${res.status}): ${await res.text()}`
      );
    }
  }
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. commit()'s atomicity is the `version=eq.N` in the query string — Postgres updates zero
//    rows if the version moved, and zero rows back IS the conflict. Splitting it into
//    read-then-update reopens the race.
//
// 2. reduceCommit() is a bounded retry over that CAS. Under extreme contention it throws
//    rather than looping forever — the correct failure, surfaced not silent. A true hotspot
//    needs a DB-level commutative reducer (ADR-028 D5's deferred trigger).
//
// 3. Raw fetch, not the JS client, and that is load-bearing: it is what makes the
//    conformance arm possible. See the module header and TASK-066.
