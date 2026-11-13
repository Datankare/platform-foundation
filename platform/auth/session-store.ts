/**
 * platform/auth/session-store.ts — where sign-in sessions are recorded (ADR-057 D1, TASK-214)
 *
 * One record per session, in the request's tenant (auth_sessions, migration 070; row-level
 * security). The store never sees a session id — only its SHA-256 — nor an unsealed token
 * (platform/auth/session-vault.ts seals them first).
 *
 *   PostgresSessionStore   through platform/data, under row-level security. Used whenever the
 *                          deployment has a database.
 *   MemorySessionStore     each tenant's sessions kept apart the same way; for tests and local
 *                          runs without a database. Production refuses it (the ADR-048 D3 rule),
 *                          except under the E2E harness's explicit opt-out.
 *
 * Both pass the same conformance kit (__tests__/contract/session-store-contract.ts).
 *
 * @module platform/auth
 */

import { withTenantTx, hasDatabase } from "@/platform/data";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";
import { allowsHarnessSwitches } from "@/platform/providers/environment-contract";
import type { SealedTokens } from "@/platform/auth/session-vault";

export type SessionKind = "user" | "guest";

/** Why a session ended. Stored with it; lower-case letters and underscores. */
export type RevocationReason =
  | "sign_out"
  | "sign_out_everywhere"
  | "rotated"
  | "idle_timeout"
  | "absolute_timeout"
  | "password_changed"
  | "factor_changed"
  | "role_changed"
  | "account_restricted"
  | "account_erased"
  | "tenant_changed"
  | "provider_refused"
  | "unreadable";

export interface SessionRecord {
  /** SHA-256 (hex) of the session id. */
  readonly idHash: string;
  readonly kind: SessionKind;
  /** The provider's subject for a user; the guest id for a guest. */
  readonly subject: string;
  /** How the session was obtained (password, mfa, sso, guest, migrated, …). */
  readonly method: string;
  readonly csrfToken: string;
  readonly sealedTokens: SealedTokens;
  readonly tokenVersion: number;
  /** ms since the epoch. */
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt?: number;
  readonly revokedReason?: string;
}

export type NewSession = Omit<
  SessionRecord,
  "tokenVersion" | "revokedAt" | "revokedReason"
>;

export interface SessionStore {
  /** Record a new session. Rejects when its id hash already exists. */
  open(session: NewSession): Promise<void>;
  /** The session with this id hash in the current tenant, ended or not; null when none. */
  find(idHash: string): Promise<SessionRecord | null>;
  /** Mark a live session as used at `at`; false when it is not live. Never moves time back. */
  touch(idHash: string, at: number): Promise<boolean>;
  /**
   * Store renewed tokens, only when the session is live and its token version is still
   * `expectedVersion` (concurrent renewals: one wins). True when stored.
   */
  replaceTokens(
    idHash: string,
    expectedVersion: number,
    sealed: SealedTokens
  ): Promise<boolean>;
  /** End a live session; false when it was not live (already ended, or none). */
  revoke(idHash: string, reason: RevocationReason, at: number): Promise<boolean>;
  /**
   * End every live session of `subject` in the current tenant, except `exceptIdHash`. The
   * sessions it ended, as they were (so their provider tokens can be revoked).
   */
  revokeSubject(
    subject: string,
    reason: RevocationReason,
    at: number,
    exceptIdHash?: string
  ): Promise<SessionRecord[]>;
  /** How many live sessions `subject` has in the current tenant. */
  countLive(subject: string): Promise<number>;
  /** Forget the current tenant's sessions (tests). */
  reset(): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new TenantPartitionedMap<string, SessionRecord>();

  async open(session: NewSession): Promise<void> {
    const map = this.sessions.current();
    if (map.has(session.idHash)) throw new Error("session id hash already recorded");
    map.set(session.idHash, { ...session, tokenVersion: 1 });
  }

  async find(idHash: string): Promise<SessionRecord | null> {
    return this.sessions.current().get(idHash) ?? null;
  }

  async touch(idHash: string, at: number): Promise<boolean> {
    const map = this.sessions.current();
    const s = map.get(idHash);
    if (!s || s.revokedAt !== undefined) return false;
    if (at > s.lastSeenAt) map.set(idHash, { ...s, lastSeenAt: at });
    return true;
  }

  async replaceTokens(
    idHash: string,
    expectedVersion: number,
    sealed: SealedTokens
  ): Promise<boolean> {
    // Synchronous check-and-set: no await between them, so two renewals cannot both store.
    const map = this.sessions.current();
    const s = map.get(idHash);
    if (!s || s.revokedAt !== undefined || s.tokenVersion !== expectedVersion)
      return false;
    map.set(idHash, { ...s, sealedTokens: sealed, tokenVersion: s.tokenVersion + 1 });
    return true;
  }

  async revoke(idHash: string, reason: RevocationReason, at: number): Promise<boolean> {
    const map = this.sessions.current();
    const s = map.get(idHash);
    if (!s || s.revokedAt !== undefined) return false;
    map.set(idHash, { ...s, revokedAt: at, revokedReason: reason });
    return true;
  }

  async revokeSubject(
    subject: string,
    reason: RevocationReason,
    at: number,
    exceptIdHash?: string
  ): Promise<SessionRecord[]> {
    const map = this.sessions.current();
    const ended: SessionRecord[] = [];
    for (const [idHash, s] of map) {
      if (s.subject !== subject || s.revokedAt !== undefined || idHash === exceptIdHash)
        continue;
      ended.push(s);
      map.set(idHash, { ...s, revokedAt: at, revokedReason: reason });
    }
    return ended;
  }

  async countLive(subject: string): Promise<number> {
    let n = 0;
    for (const s of this.sessions.current().values()) {
      if (s.subject === subject && s.revokedAt === undefined) n += 1;
    }
    return n;
  }

  async reset(): Promise<void> {
    this.sessions.current().clear();
  }
}

interface Row {
  id_hash: string;
  kind: SessionKind;
  subject: string;
  method: string;
  csrf_token: string;
  sealed_tokens: string;
  token_version: number;
  created_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

const ms = (v: Date | string): number => (v instanceof Date ? v : new Date(v)).getTime();

function fromRow(r: Row): SessionRecord {
  return {
    idHash: r.id_hash,
    kind: r.kind,
    subject: r.subject,
    method: r.method,
    csrfToken: r.csrf_token,
    sealedTokens: r.sealed_tokens as SealedTokens,
    tokenVersion: Number(r.token_version),
    createdAt: ms(r.created_at),
    lastSeenAt: ms(r.last_seen_at),
    ...(r.revoked_at !== null
      ? { revokedAt: ms(r.revoked_at), revokedReason: r.revoked_reason ?? "sign_out" }
      : {}),
  };
}

/** SessionStore on Postgres through platform/data, in the request's tenant. */
export class PostgresSessionStore implements SessionStore {
  async open(session: NewSession): Promise<void> {
    await withTenantTx((tx) =>
      tx.query(
        `insert into auth_sessions
           (id_hash, kind, subject, method, csrf_token, sealed_tokens, created_at, last_seen_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
        [
          session.idHash,
          session.kind,
          session.subject,
          session.method,
          session.csrfToken,
          session.sealedTokens,
          new Date(session.createdAt).toISOString(),
          new Date(session.lastSeenAt).toISOString(),
        ]
      )
    );
  }

  async find(idHash: string): Promise<SessionRecord | null> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<Row>(
        "select id_hash, kind, subject, method, csrf_token, sealed_tokens, token_version, created_at, last_seen_at, revoked_at, revoked_reason from auth_sessions where id_hash = $1",
        [idHash]
      )
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async touch(idHash: string, at: number): Promise<boolean> {
    const { rowCount } = await withTenantTx((tx) =>
      tx.query(
        `update auth_sessions set last_seen_at = greatest(last_seen_at, $2::timestamptz)
          where id_hash = $1 and revoked_at is null`,
        [idHash, new Date(at).toISOString()]
      )
    );
    return (rowCount ?? 0) > 0;
  }

  async replaceTokens(
    idHash: string,
    expectedVersion: number,
    sealed: SealedTokens
  ): Promise<boolean> {
    const { rowCount } = await withTenantTx((tx) =>
      tx.query(
        `update auth_sessions set sealed_tokens = $3, token_version = token_version + 1
          where id_hash = $1 and token_version = $2 and revoked_at is null`,
        [idHash, expectedVersion, sealed]
      )
    );
    return (rowCount ?? 0) > 0;
  }

  async revoke(idHash: string, reason: RevocationReason, at: number): Promise<boolean> {
    const { rowCount } = await withTenantTx((tx) =>
      tx.query(
        `update auth_sessions set revoked_at = $3::timestamptz, revoked_reason = $2
          where id_hash = $1 and revoked_at is null`,
        [idHash, reason, new Date(at).toISOString()]
      )
    );
    return (rowCount ?? 0) > 0;
  }

  async revokeSubject(
    subject: string,
    reason: RevocationReason,
    at: number,
    exceptIdHash?: string
  ): Promise<SessionRecord[]> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<Row>(
        `update auth_sessions set revoked_at = $3::timestamptz, revoked_reason = $2
          where subject = $1 and revoked_at is null and id_hash <> $4
        returning id_hash, kind, subject, method, csrf_token, sealed_tokens, token_version, created_at, last_seen_at, revoked_at, revoked_reason`,
        [subject, reason, new Date(at).toISOString(), exceptIdHash ?? ""]
      )
    );
    // As they were: the caller revokes their provider tokens; they are ended in the store now.
    return rows.map((r) => fromRow({ ...r, revoked_at: null, revoked_reason: null }));
  }

  async countLive(subject: string): Promise<number> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from auth_sessions where subject = $1 and revoked_at is null",
        [subject]
      )
    );
    return rows[0]?.n ?? 0;
  }

  async reset(): Promise<void> {
    await withTenantTx((tx) => tx.query("delete from auth_sessions"));
  }
}

const STORE_KEY = "platform.auth.sessionStore";

/**
 * The session store: Postgres whenever the deployment has a database, memory otherwise — and in
 * a production build memory is refused (sessions that vanish on a restart, kept apart on every
 * instance) unless the E2E harness opted out on a local or CI host.
 */
export function getSessionStore(): SessionStore {
  return getSingleton<SessionStore>(STORE_KEY, () => {
    if (hasDatabase()) return new PostgresSessionStore();
    if (
      process.env.NODE_ENV === "production" &&
      !(process.env.E2E_IN_MEMORY_STORES === "true" && allowsHarnessSwitches())
    ) {
      throw new Error(
        "Sign-in sessions need a database in production (DATABASE_URL): refusing in-memory sessions (ADR-057 D1, ADR-048 D3)."
      );
    }
    return new MemorySessionStore();
  });
}

export function setSessionStore(store: SessionStore): void {
  setSingleton(STORE_KEY, store);
}
