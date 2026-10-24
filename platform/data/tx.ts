/**
 * platform/data/tx.ts — transactions for a tenant, for the platform, and for operators
 * (ADR-053 D4). See ./index.ts for the model.
 *
 * @module platform/data
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient, QueryResultRow } from "pg";
import { getDatabaseSettings } from "@/platform/providers/environment-contract";
import { currentTenant } from "@/platform/tenancy/context";
import { getPool, type PoolRole } from "./pool";

/** What a transaction offers: parameterised queries, nothing else. */
export interface Tx {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: R[]; rowCount: number }>;
  /** The tenant this transaction is scoped to; undefined for platform and owner transactions. */
  readonly tenantId: string | undefined;
}

/** The database could not be reached or a connection could not be had. Routes answer 503. */
export class DataUnavailableError extends Error {
  readonly code = "data.unavailable";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataUnavailableError";
  }
}

/** A transaction of one kind was opened inside another kind. A programming error. */
export class DataScopeError extends Error {
  readonly code = "data.scope";
  constructor(message: string) {
    super(message);
    this.name = "DataScopeError";
  }
}

/**
 * The operator purposes that may use the owner connection. Adding one is a reviewed change:
 * each is a path that runs outside row-level security.
 */
export const OWNER_PURPOSES = [
  /** Provisioning, suspending, exporting and deleting tenants, and their domains (D7). */
  "tenant-lifecycle",
  /** An operator reading or acting across tenants through an audited operator route. */
  "operator",
  /**
   * The job runner: scheduling, claiming and settling jobs, which it then runs inside each job's
   * tenant (ADR-056 D2).
   */
  "job-claim",
  /**
   * A platform job the runner runs on the platform's own schedule — cross-tenant housekeeping
   * such as expiring stale approvals and pruning job history. Never a request (ADR-056 D3).
   */
  "platform-job",
] as const;
export type OwnerPurpose = (typeof OWNER_PURPOSES)[number];

type Kind = "tenant" | "platform" | `owner:${OwnerPurpose}`;

interface Active {
  readonly kind: Kind;
  readonly tenantId: string | undefined;
  readonly tx: Tx;
  /** True once the transaction has committed or rolled back: it can no longer be joined. */
  readonly closed: () => boolean;
}

/**
 * How long an owner snapshot (a streamed export) may sit idle between statements before the
 * server ends it. A stalled reader then loses its export instead of holding a snapshot — and the
 * old row versions it pins — indefinitely. Overridable per call (withOwnerSnapshot options).
 */
export const OWNER_SNAPSHOT_IDLE_TIMEOUT_MS = 5 * 60_000;

const ACTIVE_KEY = Symbol.for("datankare.platform.data.activeTx.v1");
type Holder = { [ACTIVE_KEY]?: AsyncLocalStorage<Active> };
function active(): AsyncLocalStorage<Active> {
  const g = globalThis as Holder;
  g[ACTIVE_KEY] ??= new AsyncLocalStorage<Active>();
  return g[ACTIVE_KEY];
}

/** Postgres error classes that mean the connection, not the query, failed. */
function isConnectionFailure(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string") {
    // 08 — connection exception; 57P01–57P03 — admin shutdown, crash shutdown, cannot connect now;
    // 53300 — too many connections.
    if (code.startsWith("08") || /^57P0[1-3]$/.test(code) || code === "53300")
      return true;
    // Node socket errors.
    if (
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)
    ) {
      return true;
    }
  }
  const message = err instanceof Error ? err.message : "";
  return /timeout exceeded when trying to connect|Connection terminated/i.test(message);
}

interface RunOptions {
  /** One consistent, read-only view of the database for the whole transaction. */
  readonly snapshot?: boolean;
  /**
   * How long the transaction may wait on its caller between statements (a streamed export);
   * without it the idle bound is the statement timeout.
   */
  readonly idleTimeoutMs?: number;
}

async function run<T>(
  role: PoolRole,
  kind: Kind,
  tenantId: string | undefined,
  fn: (tx: Tx) => Promise<T>,
  options: RunOptions = {}
): Promise<T> {
  // A scope whose transaction has ended (work scheduled inside it that outlived it: an
  // un-awaited promise, a timer) is not joined — its connection may already serve another
  // transaction, even another tenant's. Such work opens its own transaction.
  const store = active().getStore();
  const outer = store && !store.closed() ? store : undefined;
  if (outer) {
    if (outer.kind !== kind || outer.tenantId !== tenantId) {
      throw new DataScopeError(
        `A ${kind} transaction cannot run inside a ${outer.kind} transaction`
      );
    }
    return fn(outer.tx); // join: one connection per unit of work
  }

  let client: PoolClient;
  try {
    client = await (await getPool(role)).connect();
  } catch (err) {
    throw new DataUnavailableError("No database connection could be had", { cause: err });
  }

  let broken = false;
  // A checked-out client the server ends (an idle-in-transaction timeout, a restart) emits
  // "error"; unheard, that would crash the process. The query in flight fails on its own; the
  // connection is marked broken so it is destroyed, not returned.
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  // Set before commit or rollback is sent, so nothing issued from here on reaches the
  // connection: once released it may be inside another tenant's transaction.
  let closed = false;
  const tx: Tx = {
    tenantId,
    async query(text, values) {
      if (typeof text !== "string") throw new TypeError("SQL text must be a string");
      if (closed) {
        throw new DataScopeError(
          `This ${kind} transaction has ended; a query on it would run on a connection another transaction may hold`
        );
      }
      try {
        const r = await client.query(text, values as unknown[] | undefined);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      } catch (err) {
        if (isConnectionFailure(err)) {
          broken = true;
          throw new DataUnavailableError("The database connection failed", {
            cause: err,
          });
        }
        throw err;
      }
    },
  };

  const timeout = String(getDatabaseSettings().statementTimeoutMs);
  try {
    await tx.query(
      options.snapshot ? "begin isolation level repeatable read read only" : "begin"
    );
    // Transaction-local (third argument true): gone at commit or rollback, so the pooled
    // connection carries nothing into the next transaction. An empty tenant id would match
    // nothing, but it is never set: platform and owner transactions do not set it at all.
    if (tenantId !== undefined) {
      await tx.query(
        "select set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [tenantId, timeout]
      );
    } else {
      await tx.query(
        "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [timeout, String(options.idleTimeoutMs ?? timeout)]
      );
    }
    const result = await active().run({ kind, tenantId, tx, closed: () => closed }, () =>
      fn(tx)
    );
    closed = true;
    try {
      await client.query("commit");
    } catch (err) {
      if (isConnectionFailure(err)) {
        broken = true;
        throw new DataUnavailableError("The database connection failed", { cause: err });
      }
      throw err;
    }
    return result;
  } catch (err) {
    closed = true;
    if (!broken) {
      try {
        await client.query("rollback");
      } catch {
        broken = true;
      }
    }
    throw err;
  } finally {
    closed = true;
    client.off("error", onError);
    // A connection whose state is unknown is destroyed, never returned to the pool.
    client.release(broken ? true : undefined);
  }
}

/** Run `fn` in a transaction scoped to the current tenant (throws when there is none). */
export async function withTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { tenantId } = currentTenant();
  return run("request", "tenant", tenantId, fn);
}

/** Run `fn` as the request role with no tenant: platform-owned tables only. */
export async function withPlatformTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return run("request", "platform", undefined, fn);
}

/**
 * Run `fn` as the owner on one consistent, read-only snapshot that may wait on its caller between
 * statements — for streaming an export. Each statement is still bounded by the statement
 * timeout, and each wait by `idleTimeoutMs` (default OWNER_SNAPSHOT_IDLE_TIMEOUT_MS): a reader
 * stalled longer loses the connection, and with it the snapshot.
 */
export async function withOwnerSnapshot<T>(
  purpose: OwnerPurpose,
  fn: (tx: Tx) => Promise<T>,
  options: { readonly idleTimeoutMs?: number } = {}
): Promise<T> {
  if (!(OWNER_PURPOSES as readonly string[]).includes(purpose)) {
    throw new DataScopeError(`Not an owner purpose: ${String(purpose)}`);
  }
  const idle = options.idleTimeoutMs ?? OWNER_SNAPSHOT_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(idle) || idle < 1 || idle > 60 * 60_000) {
    throw new RangeError("idleTimeoutMs must be 1 ms – 1 hour");
  }
  return run("owner", `owner:${purpose}`, undefined, fn, {
    snapshot: true,
    idleTimeoutMs: idle,
  });
}

/** Run `fn` as the owner, for one of the listed operator purposes. Never on a request path. */
export async function withOwnerTx<T>(
  purpose: OwnerPurpose,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  if (!(OWNER_PURPOSES as readonly string[]).includes(purpose)) {
    throw new DataScopeError(`Not an owner purpose: ${String(purpose)}`);
  }
  return run("owner", `owner:${purpose}`, undefined, fn);
}
