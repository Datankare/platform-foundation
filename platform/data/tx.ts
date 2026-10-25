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

/**
 * The commit was sent and the connection failed before it answered (review 13 L5, review 14 L-2):
 * the transaction may have committed or not. A DataUnavailableError (routes answer 503), told
 * apart so a caller can record `indeterminate` — never "failed" — and still run what must follow
 * a change that may have landed (a cache invalidation).
 */
export class CommitOutcomeUnknownError extends DataUnavailableError {
  readonly indeterminate = true;
  constructor(options?: { cause?: unknown }) {
    super(
      "The database connection failed while the transaction was committing: whether it took effect is unknown",
      options
    );
    this.name = "CommitOutcomeUnknownError";
  }
}

/** Whether `err` says a commit's outcome is unknown (CommitOutcomeUnknownError). */
export function isCommitOutcomeUnknown(err: unknown): boolean {
  return (
    err instanceof CommitOutcomeUnknownError ||
    (err as { indeterminate?: unknown } | null)?.indeterminate === true
  );
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
  /**
   * Run after the transaction rolls back (review 12 L1): what a write joined to it recorded as
   * done did not happen, and a record of that is written then, outside it. Discarded at commit.
   * Told whether it is known to have rolled back, or whether the commit's outcome is unknown
   * (review 13 L5: the connection failed while the commit was in flight — it may have landed).
   */
  readonly rollbackHooks: RollbackHook[];
  /**
   * Run after the transaction commits (review 13 L5): a step that must not happen unless the
   * transaction's writes did — publishing a cache invalidation, which other instances would
   * otherwise act on before the change is visible. Discarded on rollback. One marked idempotent
   * (review 14 L-2) also runs when the commit's outcome is unknown.
   */
  readonly commitHooks: CommitHook[];
}

/** A step registered with onCommit. */
interface CommitHook {
  readonly run: () => Promise<void>;
  /** Harmless if the transaction did not commit (an invalidation): run on an unknown outcome too. */
  readonly idempotent: boolean;
}

/** How a transaction a hook was registered in ended, when it did not commit. */
export type TxEndOutcome = "rolled_back" | "indeterminate";
/** A hook run when its transaction did not commit (onRollback). */
export type RollbackHook = (outcome: TxEndOutcome) => Promise<void>;

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
  const rollbackHooks: RollbackHook[] = [];
  const commitHooks: CommitHook[] = [];
  // Set when the commit was sent and the connection failed before it answered: the transaction
  // may have committed or not (review 13 L5).
  let commitUnknown = false;
  let afterCommit: CommitHook[] = [];
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
    // TimeZone is UTC in every transaction (TASK-159): `now() + interval '30 days'` and date_trunc
    // are calendar arithmetic in the session's time zone, so a database or role set to
    // America/New_York made a 30-day purge window 30 days and an hour across a DST change.
    if (tenantId !== undefined) {
      await tx.query(
        "select set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $2, true), set_config('TimeZone', 'UTC', true)",
        [tenantId, timeout]
      );
    } else {
      await tx.query(
        "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true), set_config('TimeZone', 'UTC', true)",
        [timeout, String(options.idleTimeoutMs ?? timeout)]
      );
    }
    const result = await active().run(
      { kind, tenantId, tx, closed: () => closed, rollbackHooks, commitHooks },
      () => fn(tx)
    );
    closed = true;
    try {
      await client.query("commit");
    } catch (err) {
      if (isConnectionFailure(err)) {
        broken = true;
        commitUnknown = true;
        throw new CommitOutcomeUnknownError({ cause: err });
      }
      throw err;
    }
    rollbackHooks.length = 0;
    afterCommit = commitHooks.splice(0);
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
    // Rolled back (or never committed): what joined it is undone; each hook records that, in a
    // transaction of its own. A hook's failure is its own (logged by it); the error stands. A
    // commit whose answer was lost with the connection is not known to have rolled back: the
    // hooks are told "indeterminate" (review 13 L5), never "rolled_back". Then the commit hooks
    // marked idempotent run all the same (review 14 L-2): the change may have landed, and an
    // invalidation not published for it would leave other instances serving the old value; one
    // published for a change that did not land costs a re-read.
    if (commitUnknown) afterCommit = commitHooks.filter((h) => h.idempotent);
    commitHooks.length = 0;
    await runRollbackHooks(
      rollbackHooks.splice(0),
      commitUnknown ? "indeterminate" : "rolled_back"
    );
    throw err;
  } finally {
    closed = true;
    client.off("error", onError);
    // A connection whose state is unknown is destroyed, never returned to the pool.
    client.release(broken ? true : undefined);
    // Committed (or, for idempotent steps, perhaps committed): the steps that follow it, once the
    // connection is back (they open their own).
    if (afterCommit.length) await runCommitHooks(afterCommit);
  }
}

/** Run `fn` in a transaction scoped to the current tenant (throws when there is none). */
export async function withTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { tenantId } = currentTenant();
  return run("request", "tenant", tenantId, fn);
}

/**
 * Run `fn` in a transaction of the current tenant of its own — never joining one the caller is
 * in — so what it writes commits whether or not the caller's transaction does (review 11 L-6: an
 * atomic action's "attempted" and "failed" audit records rolled back with the action). Uses a
 * second connection while the caller's is held. For records of an attempt only; an effect
 * belongs in the caller's transaction.
 */
export async function withSeparateTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { tenantId } = currentTenant();
  return active().exit(() => run("request", "tenant", tenantId, fn));
}

/** Whether the caller is inside an open transaction (which a tenant write would join). */
export function inTransaction(): boolean {
  const store = active().getStore();
  return Boolean(store && !store.closed());
}

/**
 * Run `hook` if the open transaction the caller is in rolls back — after the rollback, outside it
 * — or, under a savepoint, if the savepoint is rolled back (review 12 L1). Returns false (and
 * registers nothing) when the caller is in no open transaction. For records of something done
 * inside the transaction that the rollback undid; never for an effect.
 */
export function onRollback(hook: RollbackHook): boolean {
  const store = active().getStore();
  if (!store || store.closed()) return false;
  store.rollbackHooks.push(hook);
  return true;
}

/**
 * Run `hook` after the open transaction the caller is in commits — outside it — and never if it
 * rolls back (or the savepoint it was registered under is rolled back). Returns false (and
 * registers nothing) when the caller is in no open transaction: then the caller runs the step
 * itself, at once (review 13 L5). For a step outside the database that must follow the
 * transaction's writes (a cache invalidation), never for a database effect.
 *
 * `{ idempotent: true }` (review 14 L-2): the step is harmless if the transaction did not commit —
 * an invalidation, which costs only a re-read — so it also runs when the commit's outcome is
 * unknown (the connection failed while the commit was in flight: the change may have landed).
 * Without it a lost commit dropped the invalidation of a change that may stand.
 */
export function onCommit(
  hook: () => Promise<void>,
  options: { readonly idempotent?: boolean } = {}
): boolean {
  const store = active().getStore();
  if (!store || store.closed()) return false;
  store.commitHooks.push({ run: hook, idempotent: options.idempotent === true });
  return true;
}

async function runRollbackHooks(
  hooks: readonly RollbackHook[],
  outcome: TxEndOutcome
): Promise<void> {
  for (const hook of hooks) {
    try {
      await active().exit(() => hook(outcome));
    } catch {
      // The hook reports its own failure.
    }
  }
}

async function runCommitHooks(hooks: readonly CommitHook[]): Promise<void> {
  for (const hook of hooks) {
    try {
      await active().exit(hook.run);
    } catch {
      // Best effort, as a step after a commit is: the hook reports its own failure.
    }
  }
}

/**
 * Run `fn` under a savepoint of `tx`: when it throws, only its own statements are undone and `tx`
 * stays usable — a retry inside a joined transaction is possible (review 11 L-6: a unique
 * violation aborted the caller's whole transaction, and the retry ran in the aborted one).
 */
export async function withSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  // One name for every savepoint: a nested one shadows the outer, and rollback/release act on
  // the most recent of that name — so nesting works, and no SQL text is built.
  await tx.query("savepoint pf_savepoint");
  // Rollback hooks registered under the savepoint run when it is rolled back (review 12 L1);
  // released, they belong to the transaction.
  const store = active().getStore();
  const mark = store?.rollbackHooks.length ?? 0;
  const commitMark = store?.commitHooks.length ?? 0;
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    let undone = false;
    try {
      await tx.query("rollback to savepoint pf_savepoint");
      undone = true;
      await tx.query("release savepoint pf_savepoint");
    } catch {
      // The transaction itself failed; the caller's error stands.
    }
    if (undone && store) {
      // What ran under the savepoint is undone: its commit hooks go, its rollback hooks run.
      store.commitHooks.splice(commitMark);
      await runRollbackHooks(store.rollbackHooks.splice(mark), "rolled_back");
    }
    throw err;
  }
  await tx.query("release savepoint pf_savepoint");
  return result;
}

/**
 * Run `fn` in a read-only transaction of the current tenant on one consistent snapshot
 * (repeatable read) — for reading a whole export page by page without a row read twice or
 * missed between pages (review 7 M2). Throws when there is no tenant.
 */
export async function withTenantSnapshot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { tenantId } = currentTenant();
  return run("request", "tenant", tenantId, fn, { snapshot: true });
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
