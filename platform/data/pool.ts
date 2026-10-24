/**
 * platform/data/pool.ts — the two connection pools (ADR-053 D4)
 *
 * One pool per role per instance: the request pool (DATABASE_URL, app_tenant) and the owner pool
 * (DATABASE_OWNER_URL). Both are created on first use and sized by DATABASE_POOL_MAX — serverless
 * instances keep it at 1–3 and rely on the transaction-mode pooler in front of Postgres; a
 * long-running container may hold more.
 *
 * TLS (DATABASE_SSL): verify-full checks the server certificate (DATABASE_SSL_CA when the
 * provider's CA is not in the system store); require encrypts without checking; disable is for
 * local and CI runs, which the environment contract enforces.
 *
 * @module platform/data
 */

import type { Pool, PoolConfig } from "pg";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { getDatabaseSettings } from "@/platform/providers/environment-contract";

export type PoolRole = "request" | "owner";

/** Builds a pool for a role; replaceable so tests and other hosts can supply their own. */
export type PoolFactory = (role: PoolRole) => Pool | Promise<Pool>;

const KEY = "platform.data.pools";

interface Pools {
  factory: PoolFactory;
  pools: Partial<Record<PoolRole, Promise<Pool>>>;
}

export function poolConfig(role: PoolRole): PoolConfig {
  const s = getDatabaseSettings();
  const url = role === "request" ? s.url : s.ownerUrl;
  if (!url) {
    throw new Error(
      role === "request"
        ? "DATABASE_URL is not set — the request connection is required for data access"
        : "DATABASE_OWNER_URL is not set — operator paths need the owner connection"
    );
  }
  // Encrypted and verified, or (local and CI only, refused elsewhere by the contract) plaintext.
  // Never encrypted-but-unverified: that is open to a man in the middle.
  const ssl =
    s.ssl === "disable"
      ? false
      : { rejectUnauthorized: true, ...(s.sslCa ? { ca: s.sslCa } : {}) };
  return {
    connectionString: url,
    ssl,
    max: s.poolMax,
    // Serverless instances freeze between requests; idle connections are closed promptly so the
    // pooler's slots are not held by instances that may never wake.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // A pooled connection is reused across transactions; never across sessions' settings.
    application_name: role === "request" ? "platform-request" : "platform-owner",
    allowExitOnIdle: true,
  };
}

// The driver is loaded on first use, not on import: modules that import platform/data can be
// imported where no database is ever reached (and where Node's driver cannot load) without it.
const defaultFactory: PoolFactory = async (role) => {
  const { Pool: PgPool } = await import("pg");
  const pool = new PgPool(poolConfig(role));
  // An idle client's error (the server closed it) must not crash the process; the next checkout
  // gets a fresh connection.
  pool.on("error", () => undefined);
  return pool;
};

function state(): Pools {
  return getSingleton<Pools>(KEY, () => ({ factory: defaultFactory, pools: {} }));
}

/**
 * Whether this deployment has a database: DATABASE_URL is set. Code that persists nothing
 * without one (mock and CI runs) asks this, never whether a Supabase URL happens to be set.
 */
export function hasDatabase(): boolean {
  return getDatabaseSettings().url !== undefined;
}

export function getPool(role: PoolRole): Promise<Pool> {
  const s = state();
  // One pool per role, even when two first uses race: the promise is stored at once.
  s.pools[role] ??= Promise.resolve().then(() => s.factory(role));
  const pending = s.pools[role];
  // A factory that failed (no DATABASE_URL) is not remembered: the next use tries again.
  pending.catch(() => {
    if (s.pools[role] === pending) delete s.pools[role];
  });
  return pending;
}

/** Replace how pools are built (closing any open ones). */
export async function setDataPoolFactory(factory: PoolFactory): Promise<void> {
  await closeDataPools();
  setSingleton<Pools>(KEY, { factory, pools: {} });
}

/** Close every open pool (tests, shutdown). */
export async function closeDataPools(): Promise<void> {
  const s = state();
  const open = Object.values(s.pools);
  s.pools = {};
  await Promise.all(
    open.map((p) => p?.then((pool) => pool.end()).catch(() => undefined))
  );
}
