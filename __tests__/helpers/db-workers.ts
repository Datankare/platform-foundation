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
 * A run's copies are its own (TASK-219). The map names the process that made them (`owner`, the
 * jest process whose globalSetup ran) and the database they copy (`baseUrl`, `baseOwnerUrl`):
 *
 *   - only that process drops them (db-global-teardown.ts compares its pid): a jest run started
 *     inside a test — __tests__/env-isolation.test.ts starts one, with the test's environment,
 *     map included — once dropped every copy of the live run from its own teardown, and every
 *     database suite after it failed (`database "replay_w1_…" does not exist`, run 43722156950);
 *   - only its workers (whose parent is that process) or that process itself (--runInBand) select
 *     one: a process outside the run is refused rather than handed a copy another worker is using;
 *   - a jest run started inside another is a run of its own: its globalSetup puts the settings
 *     back on the copied database and makes copies of its own, which its teardown drops.
 *
 * A run's copies are marked, and none outlives its run unseen (TASK-223). Each copy carries a
 * comment naming the run and the process that made it (`markCopy`: `pf test copy run=<run>
 * owner=<pid>@<host>`). The owner's teardown drops them and then checks they are gone — any left
 * fails the run (db-global-teardown.ts). A run killed before its teardown (Ctrl-C, a stopped gate,
 * a cancelled CI job) cannot drop its own: the next run on the same database finds them — a
 * marked copy whose owner was a process on this host that is no longer running, with nobody
 * connected — and drops them before making its own (`reclaimKilledCopies`, in the global setup);
 * a copy of a live run, or of another host's, is never touched. And CI's Layer 1 ends with
 * scripts/check-test-database-copies.mjs: any database named as a copy of the run's database (or
 * as a test's scratch database beside one) still there fails the job. Batch 56d-3 counted three
 * copies after a clean run: they were the copies of an earlier run with the same database name,
 * stopped right after its global setup — kept, then counted as the clean run's (TASK-223).
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
import { hostname } from "node:os";
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
  /** The jest process that made the copies (its globalSetup): the only one that drops them. */
  readonly owner: number;
  /** The copied database's settings as the run was given them (a nested run starts from them). */
  readonly baseUrl: string;
  readonly baseOwnerUrl: string;
}

/** The run's map, if this process was given one. */
export function runDatabases(
  env: Record<string, string | undefined> = process.env
): WorkerDatabases | null {
  const raw = env[WORKERS_ENV];
  return raw ? (JSON.parse(raw) as WorkerDatabases) : null;
}

/**
 * How a process stands to a run: "owner" (the jest process that made its copies), "worker" (one of
 * that process's workers), or "outside" (any other — a jest run started by a test, a script).
 */
export function roleInRun(
  workers: WorkerDatabases,
  pid: number = process.pid,
  ppid: number = process.ppid
): "owner" | "worker" | "outside" {
  if (pid === workers.owner) return "owner";
  if (ppid === workers.owner) return "worker";
  return "outside";
}

/**
 * The settings a new jest run starts from: a run started inside another (`outside` its map) is
 * given back the database that run copied, its map and selection removed, so it makes copies of
 * its own. Returns whether the settings were put back.
 */
export function leaveEnclosingRun(
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid,
  ppid: number = process.ppid
): boolean {
  const workers = runDatabases(env);
  if (workers === null || roleInRun(workers, pid, ppid) === "owner") return false;
  env.TEST_DATABASE_URL = workers.baseUrl;
  env.TEST_DATABASE_OWNER_URL = workers.baseOwnerUrl;
  delete env[WORKERS_ENV];
  delete env[BASE_URL_ENV];
  delete env[BASE_OWNER_URL_ENV];
  return true;
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

/**
 * What every copy of `base` (and a test's scratch database named after one) begins with:
 * `<base>_w` for a short plain name, `t_<hash>_w` for one workerDatabaseName shortens.
 * scripts/check-test-database-copies.mjs computes the same (db-isolation.test.ts compares them).
 */
export function copyPrefixes(base: string): string[] {
  const h = createHash("sha256").update(base).digest("hex").slice(0, 12);
  const plain = `${base}_w`;
  return /^[a-z_][a-z0-9_]*$/.test(base) ? [plain, `t_${h}_w`] : [`t_${h}_w`];
}

/** The comment a copy carries: whose run made it, which process, on which host. */
export function copyMark(run: string, pid: number, host: string): string {
  return `pf test copy run=${run} owner=${pid}@${host}`;
}

/** A copy's mark, read back; null for a database without one. */
export function readCopyMark(
  comment: string | null
): { run: string; pid: number; host: string } | null {
  const m = /^pf test copy run=([a-z0-9_]+) owner=(\d+)@(\S+)$/.exec(comment ?? "");
  return m ? { run: m[1], pid: Number(m[2]), host: m[3] } : null;
}

/** Mark `name` as a copy of the run `run`, made by this process on this host. */
export async function markCopy(
  c: Client,
  name: string,
  run: string,
  pid: number = process.pid,
  host: string = hostname()
): Promise<void> {
  await c.query(
    `comment on database ${quoteIdent(name)} is ${quoteLiteral(copyMark(run, pid, host))}`
  );
}

/** Whether process `pid` on this host is still running (one that exists, even if not ours). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Drop the copies of `base` a killed run on this host left behind — marked copies whose owning
 * process is no longer running and to which nobody is connected — with any scratch database a
 * test named after one (`<copy>_…`). Never a copy of a live run, one marked by another host, or
 * an unmarked database. Returns the names dropped.
 */
/** One database a reclaim considers: its name, its mark (comment) and how many are connected. */
export interface CopyRow {
  readonly name: string;
  readonly comment: string | null;
  readonly sessions: number;
}

/**
 * Of `rows`, the ones a reclaim drops, scratch databases first: the marked copies whose owner ran
 * on `host` and is no longer running and to which nobody is connected, and the unmarked databases
 * named after one of them (`<copy>_…`) to which nobody is connected. Everything else — a live
 * run's copy, another host's, one in use, an unmarked one of its own — is kept. (The drop itself
 * is also without FORCE, so one connected to after this read is refused by Postgres too.)
 */
export function reclaimable(
  rows: readonly CopyRow[],
  alive: (pid: number) => boolean,
  host: string
): string[] {
  const names = rows
    .filter((r) => {
      const mark = readCopyMark(r.comment);
      return mark !== null && mark.host === host && !alive(mark.pid) && r.sessions === 0;
    })
    .map((r) => r.name);
  const scratch = rows
    .filter((r) => readCopyMark(r.comment) === null && r.sessions === 0)
    .filter((r) => names.some((n) => r.name.startsWith(`${n}_`)))
    .map((r) => r.name);
  return [...scratch, ...names];
}

export async function reclaimKilledCopies(
  c: Client,
  base: string,
  alive: (pid: number) => boolean = processAlive,
  host: string = hostname(),
  /**
   * Filled, when given, with every copy of a dead run on this host that this call did NOT drop,
   * and why, as this call itself saw it: "in use" (a session at its read, or PostgreSQL's 55006
   * when it came to drop it), else the drop's error code. A caller that repeats the reclaim can
   * then tell "left because busy" from "left for any other reason" (code review B-15).
   */
  notDropped?: { name: string; why: string }[]
): Promise<string[]> {
  const { rows } = await c.query<{
    name: string;
    comment: string | null;
    sessions: number;
  }>(
    `select d.datname as name, shobj_description(d.oid, 'pg_database') as comment,
            (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as sessions
       from pg_database d
      where exists (select 1 from unnest($1::text[]) p where starts_with(d.datname::text, p))`,
    [copyPrefixes(base)]
  );
  const dropped: string[] = [];
  for (const r of rows) {
    const mark = readCopyMark(r.comment);
    if (mark !== null && mark.host === host && !alive(mark.pid) && r.sessions > 0)
      notDropped?.push({ name: r.name, why: "in use" });
  }
  for (const name of reclaimable(rows, alive, host)) {
    // No force: one someone connected to since it was read is left alone (it is in use).
    const failed = await c.query(`drop database if exists ${quoteIdent(name)}`).then(
      () => null,
      (e: { code?: string }) => e.code ?? "unknown"
    );
    if (failed === null) dropped.push(name);
    // 55006 object_in_use: "database … is being accessed by other users".
    else
      notDropped?.push({ name, why: failed === "55006" ? "in use" : `error ${failed}` });
  }
  return dropped;
}

/** Of `names` (a run's copies), those still there, with any scratch database named after one. */
export async function remainingCopies(
  c: Client,
  names: readonly string[]
): Promise<string[]> {
  if (names.length === 0) return [];
  const { rows } = await c.query<{ name: string }>(
    `select datname as name from pg_database
      where datname = any($1::text[])
         or exists (select 1 from unnest($1::text[]) n where starts_with(datname::text, n || '_'))
      order by datname`,
    [names]
  );
  return rows.map((r) => r.name);
}

/** A string as a quoted literal. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid,
  ppid: number = process.ppid
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
  if (roleInRun(workers, pid, ppid) === "outside")
    throw new Error(
      `process ${pid} is outside the jest run (process ${workers.owner}) that made these per-worker databases: it may not use one (TASK-219)`
    );
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
  // A session on the copied database blocks the copy (55006): a suite's brief read of it, or a
  // run started inside this one copying it at that moment. Asked again, briefly, then refused.
  for (let attempt = 1; ; attempt++) {
    try {
      await c.query(
        `create database ${q} template ${quoteIdent(base)} owner ${quoteIdent(want.owner)}`
      );
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "55006" || attempt >= 20) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
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
