/**
 * platform/data — the one way server code reaches Postgres (ADR-053 D4)
 *
 *   withTenantTx(fn)          the current request's or job's tenant; the request role (app_tenant,
 *                             NOBYPASSRLS) under forced row-level security. Every tenant-owned
 *                             read and write goes through this.
 *   withPlatformTx(fn)        the request role with no tenant set: only the platform-owned tables
 *                             it may read (tenants, domains, the role catalog, config defaults).
 *   withOwnerTx(purpose, fn)  the owner role, for the listed operator purposes only — never a
 *                             request path. Each purpose is named, so every use can be found.
 *
 * Each runs `fn` in one transaction on one pooled connection. The tenant is set with
 * `set_config('app.tenant_id', $1, true)` — a bound parameter, transaction-local, so a pooled
 * connection never carries one tenant's setting into another's transaction. A statement timeout
 * and an idle-in-transaction timeout bound every transaction, so a slow caller cannot hold
 * pooled connections. No network or AI call belongs inside `fn`.
 *
 * A call inside another of the same kind joins the outer transaction (one connection per unit of
 * work, no pool deadlock); a different kind inside one is refused. A transaction ends when `fn`
 * settles: its handle then refuses every query (DataScopeError), and work that outlived it (an
 * un-awaited promise, a timer) never joins it — a call made from there opens its own transaction.
 * The connection is back in the pool by then and may be serving another tenant.
 *
 * Queries take their values as bound parameters only: `tx.query(text, values)`. Building SQL text
 * from values is refused by a source check (__tests__/data-sql-hygiene.test.ts).
 *
 * @module platform/data
 */

export {
  DataUnavailableError,
  DataScopeError,
  OWNER_PURPOSES,
  OWNER_SNAPSHOT_IDLE_TIMEOUT_MS,
  withOwnerSnapshot,
  withOwnerTx,
  withPlatformTx,
  withTenantTx,
  type OwnerPurpose,
  type Tx,
} from "./tx";
export {
  closeDataPools,
  hasDatabase,
  setDataPoolFactory,
  type PoolFactory,
} from "./pool";
