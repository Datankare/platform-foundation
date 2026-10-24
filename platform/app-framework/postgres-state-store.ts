/**
 * platform/app-framework/postgres-state-store.ts — Postgres-backed state store
 *
 * Persistent ActivityStateStore (ADR-028 D2) on Postgres through platform/data (ADR-053 D4),
 * in the request's tenant: row-level security keeps each tenant's sessions apart; tenant_id
 * is filled by its column default, never written here.
 *
 * Atomicity (D5) is Postgres's:
 *   commit()        UPDATE … WHERE id = X AND version = N — zero rows is the conflict
 *   reduceCommit()  SELECT … FOR UPDATE, apply the reducer, UPDATE — one transaction, so
 *                   concurrent reducers serialise on the row lock and none is lost
 *
 * Table: app_sessions — id / state jsonb / version int / produced_by / meta jsonb (029, 049).
 *
 * @module platform/app-framework
 */

import type { ActivityStateStore, StateReducer } from "./state-store";
import type { CommitResult, SessionMeta, VersionedState } from "./types";
import { DataUnavailableError, withTenantTx } from "@/platform/data";
import { TenantContextError } from "@/platform/tenancy/context";

interface Row {
  state: unknown;
  version: number;
  produced_by: string | null;
}

export class PostgresActivityStateStore<TState> implements ActivityStateStore<TState> {
  async create(sessionId: string, initialState: TState): Promise<VersionedState<TState>> {
    try {
      await withTenantTx((tx) =>
        tx.query(
          `insert into app_sessions (id, state, version, meta)
           values ($1, $2::jsonb, 1, '{}'::jsonb)`,
          [sessionId, JSON.stringify(initialState)]
        )
      );
    } catch (err) {
      if (err instanceof TenantContextError || err instanceof DataUnavailableError)
        throw err;
      // A duplicate id surfaces as a primary-key violation. Creating over an existing
      // session would silently discard its state and its history.
      throw new Error(
        `app-framework: create failed for ${sessionId}: ${(err as Error).message}`,
        { cause: err }
      );
    }
    return { sessionId, state: initialState, version: 1 };
  }

  async load(sessionId: string): Promise<VersionedState<TState> | null> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<Row>(
        "select state, version, produced_by from app_sessions where id = $1",
        [sessionId]
      )
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
    // The CAS: the version is part of the WHERE clause, so a moved version matches no row.
    // Do NOT split this into read-then-update — that reopens the race it closes.
    const result = await withTenantTx(async (tx) => {
      const updated = await tx.query<Row>(
        `update app_sessions
            set state = $3::jsonb, version = version + 1, produced_by = $4, updated_at = now()
          where id = $1 and version = $2::int
          returning state, version, produced_by`,
        [sessionId, expectedVersion, JSON.stringify(newState), producedBy]
      );
      if (updated.rows.length) return { ok: true as const, row: updated.rows[0] };
      // Zero rows: someone else moved the version (or there is no such session). Read the
      // current state so the caller can rebase.
      const current = await tx.query<Row>(
        "select state, version, produced_by from app_sessions where id = $1",
        [sessionId]
      );
      return { ok: false as const, row: current.rows[0] };
    });
    if (result.ok) {
      return { ok: true, version: result.row.version, state: result.row.state as TState };
    }
    if (!result.row) {
      throw new Error(`app-framework: session not found on conflict: ${sessionId}`);
    }
    return {
      ok: false,
      currentVersion: result.row.version,
      currentState: result.row.state as TState,
    };
  }

  async reduceCommit(
    sessionId: string,
    reducer: StateReducer<TState>,
    producedBy: string
  ): Promise<VersionedState<TState>> {
    // The reducer is pure and synchronous (platform/kernel/state-store.ts), so it may run inside the
    // transaction while the row is locked.
    const row = await withTenantTx(async (tx) => {
      const { rows } = await tx.query<Row>(
        "select state, version, produced_by from app_sessions where id = $1 for update",
        [sessionId]
      );
      if (!rows.length) return undefined;
      const next = reducer(rows[0].state as TState);
      const updated = await tx.query<Row>(
        `update app_sessions
            set state = $2::jsonb, version = version + 1, produced_by = $3, updated_at = now()
          where id = $1
          returning state, version, produced_by`,
        [sessionId, JSON.stringify(next), producedBy]
      );
      return updated.rows[0];
    });
    if (!row) throw new Error(`app-framework: session not found: ${sessionId}`);
    return { sessionId, state: row.state as TState, version: row.version, producedBy };
  }

  async saveMeta(sessionId: string, meta: SessionMeta): Promise<void> {
    // Deliberately NOT version-guarded: meta moves on a different cadence than state, and
    // making a participant change contend with a state commit would be a conflict nobody
    // asked for.
    await withTenantTx((tx) =>
      tx.query(
        "update app_sessions set meta = $2::jsonb, updated_at = now() where id = $1",
        [sessionId, JSON.stringify(meta)]
      )
    );
  }

  async loadMeta(sessionId: string): Promise<SessionMeta | null> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ meta: unknown }>("select meta from app_sessions where id = $1", [
        sessionId,
      ])
    );
    const meta = rows[0]?.meta;
    if (!meta || typeof meta !== "object" || !Object.keys(meta).length) return null;
    return meta as SessionMeta;
  }

  async delete(sessionId: string): Promise<void> {
    await withTenantTx((tx) =>
      tx.query("delete from app_sessions where id = $1", [sessionId])
    );
  }
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. commit()'s atomicity is the `version = $2` in the WHERE clause — Postgres updates zero
//    rows if the version moved, and zero rows IS the conflict. Splitting it into
//    read-then-update reopens the race.
//
// 2. reduceCommit() holds the row lock for the reducer's run. A reducer must stay pure and
//    fast; anything slow or networked belongs before the call, not inside it.
//
// 3. app_sessions.id is the session id the caller chose, and the primary key is (id) alone
//    (049 did not widen it to (tenant_id, id)). Until it is, a session id one tenant holds
//    cannot be created by another: create() fails with the key violation.
