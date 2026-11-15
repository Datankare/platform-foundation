/**
 * __tests__/helpers/db-workers.ts — each jest worker has a database of its own (TASK-218)
 *
 * The database suites run in parallel workers. They used to share the one database the migration
 * replay builds, each working in tenants it creates; but the platform's catalogues are not a
 * tenant's — platform_config, roles, permissions, feature flags, applied migrations — and a suite
 * that adds a row there (r13.db.test.ts's `r13.reset.<tenant>`, a tenant-settable setting) was seen
 * by a suite reading the whole catalogue at that moment: operator-routes.db.test.ts compared the
 * tenant route's settings with `select key from platform_config where tenant_overridable` read a
 * moment later, and failed when r13 inserted a row in between (CI run 43633427223; the rerun
 * passed). Asserting only on what each test owns would fix that test, not the next one.
 *
 * So the class is removed where it starts: no two suites share a database while they run.
 *
 *   - jest's globalSetup (db-global-setup.ts), before any worker starts, copies the database the
 *     settings name (TEST_DATABASE_URL / TEST_DATABASE_OWNER_URL) once per worker —
 *     `CREATE DATABASE … TEMPLATE <it>`, which copies schema, data, grants and policies — and
 *     hands the workers the names (TEST_DATABASE_WORKERS);
 *   - in each worker, before a test file loads (jest.setup.ts, and helpers/db.ts for a consumer
 *     whose setup is its own), `selectWorkerDatabase()` points TEST_DATABASE_URL and
 *     TEST_DATABASE_OWNER_URL at that worker's copy, so every way a suite connects — the helper,
 *     a pg Client or Pool of its own, a script it starts — reaches it;
 *   - globalTeardown (db-global-teardown.ts) drops the copies.
 *
 * A worker runs one file at a time, so the suites that share a copy run one after another, never
 * at once. The copied database itself is never connected to while the tests run. With the
 * settings set and no copies made (a jest configuration without the global setup), selecting
 * fails rather than fall back to sharing: __tests__/db-isolation.test.ts checks each
 * configuration, and __tests__/db/worker-database.db.test.ts that a suite is on its copy.
 *
 * What a template copy does not carry is the database's own entry: its owner, its privileges
 * (migration 049 revokes TEMPORARY on the database from app_tenant and PUBLIC) and its per-database
 * settings. `copyDatabase` gives the copy the same three and checks them (`databaseLevel`), so a
 * suite sees on its copy exactly the database the replay built.
 *
 * Source: PostgreSQL documentation, "Template Databases" (CREATE DATABASE … TEMPLATE copies the
 * template's contents; no other session may be connected to the template while it is copied).
 */
import { createHash } from "node:crypto";
import type { Client } from "pg";

/** The settings the per-worker selection reads and writes. */
export const WORKERS_ENV = "TEST_DATABASE_WORKERS";
/** The database the copies were made from (kept for the isolation check; never used by a suite). */
export const BASE_URL_ENV = "TEST_DATABASE_BASE_URL";
export const BASE_OWNER_URL_ENV = "TEST_DATABASE_BASE_OWNER_URL";

/** What the global setup hands the workers. */
export interface WorkerDatabases {
  /** The copied database's name. */
  readonly base: string;
  /** Each worker's copy, by JEST_WORKER_ID ("1", "2", …). */
  readonly names: Readonly<Record<string, string>>;
}

/** The database a postgres URL names (its path, decoded). */
export function databaseOf(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name) throw new Error("the database URL names no database");
  return name;
}

/** The same URL — credentials, host, query (a session time zone) — naming another database. */
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

/** Postgres truncates identifiers past 63 bytes: a long name is shortened with a hash of it. */
const MAX_IDENT = 63;

/** Worker `worker`'s copy of `base`, for the run `run` (unique per jest run). */
export function workerDatabaseName(base: string, worker: number, run: string): string {
  if (!/^[a-z0-9_]+$/.test(run)) throw new Error(`unexpected run id: ${run}`);
  const plain = `${base}_w${worker}_${run}`;
  if (/^[a-z_][a-z0-9_]*$/.test(plain) && Buffer.byteLength(plain) <= MAX_IDENT)
    return plain;
  const h = createHash("sha256").update(base).digest("hex").slice(0, 12);
  return `t_${h}_w${worker}_${run}`;
}

/** A name as a quoted identifier (the names here are ours, but a base may be anything). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Point TEST_DATABASE_URL and TEST_DATABASE_OWNER_URL at this worker's copy. Does nothing when no
 * database is configured; idempotent; throws when one is configured but no copies were made.
 */
export function selectWorkerDatabase(
  env: Record<string, string | undefined> = process.env
): void {
  const url = env.TEST_DATABASE_URL;
  const owner = env.TEST_DATABASE_OWNER_URL;
  if (!url || !owner) return;
  const raw = env[WORKERS_ENV];
  if (!raw)
    throw new Error(
      "TEST_DATABASE_URL is set but this jest run made no per-worker databases: its configuration needs globalSetup <rootDir>/__tests__/helpers/db-global-setup.ts and globalTeardown <rootDir>/__tests__/helpers/db-global-teardown.ts (TASK-218)"
    );
  const workers = JSON.parse(raw) as WorkerDatabases;
  const id = env.JEST_WORKER_ID ?? "1";
  const name = workers.names[id];
  if (!name)
    throw new Error(
      `no per-worker database for jest worker ${id} (made: ${Object.keys(workers.names).join(", ")})`
    );
  if (databaseOf(url) === name && databaseOf(owner) === name) return;
  if (databaseOf(url) !== workers.base || databaseOf(owner) !== workers.base)
    throw new Error(
      `TEST_DATABASE_URL names ${databaseOf(url)}, not ${workers.base} the copies were made from`
    );
  env[BASE_URL_ENV] = url;
  env[BASE_OWNER_URL_ENV] = owner;
  env.TEST_DATABASE_URL = withDatabase(url, name);
  env.TEST_DATABASE_OWNER_URL = withDatabase(owner, name);
}

/** A database's own entry, as a copy must match it: owner, privileges, per-database settings. */
export interface DatabaseLevel {
  readonly owner: string;
  /** Each privilege: `<grantee or PUBLIC> <privilege>[ WITH GRANT OPTION]`, sorted. */
  readonly privileges: readonly string[];
  /** Each setting: `<role or (all)> <name=value>`, sorted. */
  readonly settings: readonly string[];
}

/** Database `name`'s owner, privileges and settings (read by a session on another database). */
export async function databaseLevel(c: Client, name: string): Promise<DatabaseLevel> {
  const owner = await c.query<{ owner: string; acl: boolean }>(
    "select pg_get_userbyid(datdba) as owner, datacl is not null as acl from pg_database where datname = $1",
    [name]
  );
  if (owner.rows.length !== 1) throw new Error(`no database ${name}`);
  const privileges = await c.query<{ p: string }>(
    `select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ' ' || a.privilege_type
            || case when a.is_grantable then ' WITH GRANT OPTION' else '' end as p
       from pg_database d,
            aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      where d.datname = $1 and a.grantee <> d.datdba`,
    [name]
  );
  const settings = await c.query<{ s: string }>(
    `select coalesce(pg_get_userbyid(nullif(s.setrole, 0)), '(all)') || ' ' || cfg as s
       from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase,
            unnest(s.setconfig) cfg
      where d.datname = $1`,
    [name]
  );
  return {
    owner: owner.rows[0].owner,
    privileges: privileges.rows.map((r) => r.p).sort(),
    settings: settings.rows.map((r) => r.s).sort(),
  };
}

/** One setting's value as SQL: each element of a list setting quoted as a literal. */
function settingValue(value: string): string {
  return value
    .split(/,\s*/)
    .map((v) => `'${v.replace(/'/g, "''")}'`)
    .join(", ");
}

/**
 * Copy `base` as `name`: the template copy, then the database's own entry — owner, privileges,
 * settings — given to the copy and checked equal. Throws (the copy dropped) when they differ.
 */
export async function copyDatabase(c: Client, base: string, name: string): Promise<void> {
  const want = await databaseLevel(c, base);
  const q = quoteIdent(name);
  await c.query(
    `create database ${q} template ${quoteIdent(base)} owner ${quoteIdent(want.owner)}`
  );
  try {
    // A new database's privileges are the defaults (PUBLIC: CONNECT, TEMPORARY): start from none.
    await c.query(`revoke all on database ${q} from public`);
    for (const p of want.privileges) {
      const m = /^(\S+) (\S+)( WITH GRANT OPTION)?$/.exec(p);
      if (!m) throw new Error(`unexpected privilege ${p}`);
      const who = m[1] === "PUBLIC" ? "public" : quoteIdent(m[1]);
      await c.query(
        `grant ${m[2]} on database ${q} to ${who}${m[3] ? " with grant option" : ""}`
      );
    }
    for (const s of want.settings) {
      const m = /^(\S+) ([^=]+)=(.*)$/.exec(s);
      if (!m) throw new Error(`unexpected setting ${s}`);
      const target =
        m[1] === "(all)" ? `database ${q}` : `role ${quoteIdent(m[1])} in database ${q}`;
      await c.query(`alter ${target} set ${quoteIdent(m[2])} to ${settingValue(m[3])}`);
    }
    const got = await databaseLevel(c, name);
    if (JSON.stringify(got) !== JSON.stringify(want))
      throw new Error(
        `the copy's own entry differs from ${base}'s: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`
      );
  } catch (e) {
    await c.query(`drop database if exists ${q} with (force)`).catch(() => {});
    throw e;
  }
}
