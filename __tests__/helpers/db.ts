/**
 * __tests__/helpers/db.ts — tests against the replayed Postgres (ADR-053 D8)
 *
 * TEST_DATABASE_URL signs in as app_tenant, TEST_DATABASE_OWNER_URL as the owner (CI: the
 * migration-replay database; locally: `npm run test:db`). Without them every `dbDescribe` suite
 * is skipped — unless REQUIRE_DB_TESTS=1, when a missing database is a failure, so CI can never
 * pass by skipping.
 *
 * Suites share one database and run in parallel, so each works only in tenants it creates
 * (`createTestTenant`), with random ids, and removes them afterwards.
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { closeDataPools, setDataPoolFactory, withOwnerTx } from "@/platform/data";
import { poolConfig } from "@/platform/data/pool";
import { runWithTenant, type TenantContext } from "@/platform/tenancy/context";

const URL = process.env.TEST_DATABASE_URL;
const OWNER = process.env.TEST_DATABASE_OWNER_URL;
export const DB_ENABLED = Boolean(URL && OWNER);

if (process.env.REQUIRE_DB_TESTS === "1" && !DB_ENABLED) {
  throw new Error(
    "REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL / TEST_DATABASE_OWNER_URL are not set"
  );
}

/**
 * The bound on every test that uses the database (review 14 M-1): 30 s, not jest's default 5 s.
 * DB suites share one database and run in parallel workers — under CI load (test:coverage,
 * test:core, the TZ rerun) a statement waits on the others, and a test well inside its work could
 * be failed by the clock. Set here, so every suite that imports this helper has it under any jest
 * configuration — a consumer's own included — and by path in jest.setup.ts for every file under
 * __tests__/db.
 */
export const DB_TEST_TIMEOUT_MS = 30_000;
jest.setTimeout(DB_TEST_TIMEOUT_MS);

/** describe() when a database is available, describe.skip() otherwise. */
export const dbDescribe: jest.Describe = DB_ENABLED ? describe : describe.skip;

const saved = { ...process.env };

/** Point platform/data at the test database. Call in beforeAll; undo with disconnectTestDatabase. */
export async function connectTestDatabase(): Promise<void> {
  process.env.DATABASE_URL = URL;
  process.env.DATABASE_OWNER_URL = OWNER;
  process.env.DATABASE_SSL = "disable";
  process.env.DATABASE_POOL_MAX = "4";
  process.env.DATABASE_STATEMENT_TIMEOUT_MS = "10000";
  await setDataPoolFactory((role) => new Pool(poolConfig(role)));
}

export async function disconnectTestDatabase(): Promise<void> {
  await closeDataPools();
  for (const k of [
    "DATABASE_URL",
    "DATABASE_OWNER_URL",
    "DATABASE_SSL",
    "DATABASE_POOL_MAX",
    "DATABASE_STATEMENT_TIMEOUT_MS",
  ]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

export interface TestTenant {
  readonly id: string;
  readonly ctx: TenantContext;
  /** Run `fn` as this tenant (a job-style scope). */
  run<T>(fn: () => T): T;
  /** A user of this tenant (created on first use), by label. */
  user(label?: string): Promise<string>;
}

const created = new Set<string>();

/** A new, empty tenant with a random id. Removed by dropTestTenants(). */
export async function createTestTenant(): Promise<TestTenant> {
  const id = randomUUID();
  const slug = `t-${id.slice(0, 8)}`;
  await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query("insert into tenants (id, slug, name) values ($1, $2, $3)", [
      id,
      slug,
      `Test ${slug}`,
    ])
  );
  created.add(id);
  const ctx: TenantContext = Object.freeze({ tenantId: id, mode: "shared" });
  const users = new Map<string, string>();
  return {
    id,
    ctx,
    run: (fn) => runWithTenant(ctx, fn),
    async user(label = "default") {
      const existing = users.get(label);
      if (existing) return existing;
      const uid = randomUUID();
      await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query(
          "insert into users (id, cognito_sub, email, role_id, tenant_id) select $1::uuid, $1::uuid, $2, r.id, $3::uuid from roles r where r.is_default",
          [uid, `${label}-${uid.slice(0, 8)}@test.example`, id]
        )
      );
      users.set(label, uid);
      return uid;
    },
  };
}

/**
 * Remove every tenant this file created and all their rows, child tables first. The owner
 * bypasses row-level security, so this sees what the tenants wrote.
 */
export async function dropTestTenants(): Promise<void> {
  if (created.size === 0) return;
  const ids = [...created];
  await withOwnerTx("tenant-lifecycle", async (tx) => {
    const { rows } = await tx.query<{ table_name: string }>(
      `select c.relname as table_name from pg_class c
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and c.relname not in ('tenants', 'tenant_domains')`
    );
    // Delete until nothing is left: foreign keys decide the order, so retry what a key blocked.
    let remaining = rows.map((r) => r.table_name);
    for (let pass = 0; pass < 10 && remaining.length > 0; pass++) {
      const blocked: string[] = [];
      for (const t of remaining) {
        await tx.query("savepoint d");
        try {
          await tx.query(
            `delete from public.${quoteIdent(t)} where tenant_id = any($1::uuid[])`,
            [ids]
          );
          await tx.query("release savepoint d");
        } catch {
          await tx.query("rollback to savepoint d");
          blocked.push(t);
        }
      }
      remaining = blocked;
    }
    if (remaining.length > 0)
      throw new Error(`could not clear test rows in: ${remaining.join(", ")}`);
    await tx.query("delete from tenant_domains where tenant_id = any($1::uuid[])", [ids]);
    await tx.query("delete from tenants where id = any($1::uuid[])", [ids]);
  });
  created.clear();
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected table name: ${name}`);
  return `"${name}"`;
}

/**
 * The store with every method run as `tenant` — so a conformance kit written without tenancy
 * exercises the store inside one tenant.
 */
export function inTenant<S extends object>(store: S, tenant: TestTenant): S {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        tenant.run(() => (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
}
