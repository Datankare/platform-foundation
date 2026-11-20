/**
 * @jest-environment node
 */
/**
 * __tests__/db/migration-074-075.db.test.ts — migrations 074 and 075 as the owner pastes them, and
 * the bound's locks never abort an application's transaction (platform TASK-229; design 56e-3a
 * §2.5, T3)
 *
 * @not-guard: it reads 074 and 075 to run them as the owner pastes them, and scans nothing.
 *
 * What it refuses: a migration of the bound that applies in part, reads rows under its locks, or holds a lock
 * an application transaction waits on past deadlock_timeout
 *
 * - Each file is ONE statement (a DO block: applies whole or not at all in every client — B-6,
 *   DB-4, DB-5) and records itself last.
 * - Pasted again: 074 changes nothing (no trigger re-made); after 075 it is refused by 064's order
 *   guard and the repair is json_bound_install() (RA2-6); 075 without 074 says so; 075 run by a
 *   role that cannot see every row says so (B-9); 074 with no anon / authenticated roles (N-1).
 * - Locks (A-3, B-1, B-2, RB2-1, RB2-6, TA-a-2, TB-a-3): install takes SHARE ROW EXCLUSIVE and reads
 *   no row; json_bound_lock waits for an application transaction and never aborts it; ONE budget
 *   per attempt: an application writer queued on the first table waits less than deadlock_timeout
 *   while nine others are slow but free (E6: < deadlock_timeout, the real requirement; the mutant
 *   with a budget per table keeps it far longer); past 30 s it fails naming the holder and its
 *   transaction's age (positive).
 * - 075 reads each table in one scan (RA2-13, RB2-10, B-5): this transaction's own counters
 *   (pg_stat_get_xact_numscans, TB-x-4), a partitioned table's leaves once each, the mutant (one scan
 *   per column) more.
 *
 * Lock waits are scripted with sessions and pg_locks polling; the one time measured (the
 * application writer's wait) is measured by the server around its own statement.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { dbDescribe, DB_ENABLED } from "../helpers/db";

const ROOT = join(__dirname, "..", "..");
const SQL_074 = readFileSync(
  join(ROOT, "supabase/migrations/074_json_bound.sql"),
  "utf8"
);
const SQL_075 = readFileSync(
  join(ROOT, "supabase/migrations/075_json_bound_existing_rows.sql"),
  "utf8"
);

let owner: Client;
const sessions: Client[] = [];
/** A new owner session (closed after the file). */
async function session(): Promise<Client> {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
  await c.connect();
  sessions.push(c);
  return c;
}
if (DB_ENABLED) {
  beforeAll(async () => {
    owner = await session();
  });
  afterAll(async () => {
    await Promise.all(sessions.map((c) => c.end().catch(() => undefined)));
  });
}

/** Run `fn` in a transaction on `c`, always rolled back. */
async function rolledBack<R>(c: Client, fn: () => Promise<R>): Promise<R> {
  await c.query("begin");
  try {
    return await fn();
  } finally {
    await c.query("rollback");
  }
}

/** The error a statement raises in its own savepoint, or null. */
async function raised(
  c: Client,
  sql: string
): Promise<{ code: string; message: string } | null> {
  await c.query("savepoint a");
  try {
    await c.query(sql);
    await c.query("release savepoint a");
    return null;
  } catch (err) {
    await c.query("rollback to savepoint a");
    return err as { code: string; message: string };
  }
}

/**
 * Make `files` the latest records, in that order, every other migration earlier (the replay
 * re-applies some older migrations on purpose after 074/075, so on a replayed database 064's
 * order guard would otherwise see them as applied later). Inside a rolled-back transaction only.
 */
async function latest(c: Client, ...files: string[]): Promise<void> {
  await c.query("alter table public.applied_migrations disable trigger user");
  await c.query(
    "update public.applied_migrations set recorded_at = timestamptz '2000-01-01' where filename <> all($1::text[])",
    [files]
  );
  for (const [i, f] of files.entries())
    await c.query(
      "update public.applied_migrations set recorded_at = timestamptz '2001-01-01' + make_interval(days => $2::int) where filename = $1",
      [f, i]
    );
  await c.query("alter table public.applied_migrations enable trigger user");
}

/** Wait (polling pg_locks, never a sleep for its own sake) until `pred` holds; at most `ms`. */
async function until(pred: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** The SQL text of a file without its comment lines, as statements split on the top level. */
function statements(sql: string): string[] {
  const text = sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n")
    .trim();
  // Dollar-quoted bodies hold semicolons; a DO block is one statement ending in `$tag$;`.
  const out: string[] = [];
  let rest = text;
  while (rest.length) {
    const m = /^do (\$[a-z0-9_]*\$)[\s\S]*?\1;/.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    out.push(m[0]);
    rest = rest.slice(m[0].length).trim();
  }
  return out;
}

dbDescribe(
  "T3: each file is one statement that records itself last (B-6, DB-4, DB-5)",
  () => {
    it.each([
      ["074", SQL_074, "074_json_bound.sql"],
      ["075", SQL_075, "075_json_bound_existing_rows.sql"],
    ])("%s: one DO statement; its record is its last act", (_n, sql, file) => {
      const s = statements(sql);
      expect(s).toHaveLength(1);
      expect(s[0]).toMatch(/^do \$m07[45]\$/);
      const body = s[0];
      expect(body.lastIndexOf("insert into public.applied_migrations")).toBeGreaterThan(
        body.lastIndexOf("perform public.json_bound_")
      );
      expect(body).toContain(`'${file}'`);
    });
  }
);

dbDescribe("T3: pasted again, out of order, by the wrong role (RA2-6, B-9, N-1)", () => {
  it("074 again before 075: nothing re-made (every trigger's catalogue version unchanged)", async () => {
    await rolledBack(owner, async () => {
      await owner.query(
        "delete from public.applied_migrations where filename = '075_json_bound_existing_rows.sql'"
      );
      await latest(owner, "074_json_bound.sql");
      const versions = async () =>
        (
          await owner.query<{ v: string }>(
            "select string_agg(xmin::text, ',' order by oid) as v from pg_trigger where tgname like 'zz_json_bound_%'"
          )
        ).rows[0].v;
      const before = await versions();
      await owner.query(SQL_074);
      expect(await versions()).toBe(before);
      const r = await owner.query<{ r: string }>(
        "select public.json_bound_install() as r"
      );
      expect(r.rows[0].r).toMatch(/ 0 \(re\)made$/);
    });
  });

  it("074 after 075: refused by 064's order guard, nothing changed; the repair is json_bound_install()", async () => {
    await rolledBack(owner, async () => {
      await latest(owner, "074_json_bound.sql", "075_json_bound_existing_rows.sql");
      const err = await raised(owner, SQL_074);
      expect(err?.message).toContain(
        "migration 074_json_bound.sql: already applied, and 075_json_bound_existing_rows.sql was applied after it"
      );
      const r = await owner.query<{ r: string }>(
        "select public.json_bound_install() as r"
      );
      expect(r.rows[0].r).toMatch(/ 0 \(re\)made$/);
    });
  });

  it("075 again: reads again, records again", async () => {
    await rolledBack(owner, async () => {
      await latest(owner, "074_json_bound.sql", "075_json_bound_existing_rows.sql");
      expect(await raised(owner, SQL_075)).toBeNull();
    });
  });

  it("075 before 074: 'apply 074 first', nothing changed", async () => {
    await rolledBack(owner, async () => {
      await owner.query("drop function public.json_bound_check(regclass)");
      const err = await raised(owner, SQL_075);
      expect(err?.message).toBe("075: migration 074 is not applied; apply 074 first");
    });
  });

  it("(B-9) the check by a role that cannot see every row says so", async () => {
    await rolledBack(owner, async () => {
      await owner.query("create role t3_nobypass nologin");
      await owner.query(
        "grant execute on function public.json_bound_check(regclass) to t3_nobypass"
      );
      await owner.query("grant usage on schema public to t3_nobypass");
      await owner.query("set local role t3_nobypass");
      const err = await raised(owner, "select public.json_bound_check()");
      await owner.query("reset role");
      expect(err?.message).toMatch(/^json_bound_check: t3_nobypass cannot see every row/);
    });
  });

  it("(N-1) 074 on a database without anon and authenticated (an adopter's): no error", async () => {
    await rolledBack(owner, async () => {
      await owner.query(
        "delete from public.applied_migrations where filename = '075_json_bound_existing_rows.sql'"
      );
      await latest(owner, "074_json_bound.sql");
      for (const r of ["anon", "authenticated", "service_role"]) {
        const { rows } = await owner.query<{ ok: boolean }>(
          "select to_regrole($1) is not null as ok",
          [r]
        );
        if (rows[0].ok) await owner.query(`alter role ${r} rename to t3_gone_${r}`);
      }
      expect(await raised(owner, SQL_074)).toBeNull();
    });
  });
});

dbDescribe(
  "T3: install takes SHARE ROW EXCLUSIVE and reads no row (A-3, B-1, B-5)",
  () => {
    it("a table re-made: no ACCESS EXCLUSIVE; rows returned from it 0 (this transaction's counters)", async () => {
      const watcher = await session();
      await rolledBack(owner, async () => {
        await owner.query(
          "alter table public.proposals disable trigger zz_json_bound_ins"
        );
        const { rows: pid } = await owner.query<{ p: number }>(
          "select pg_backend_pid() as p"
        );
        const read = async () =>
          Number(
            (
              await owner.query<{ n: string }>(
                "select pg_stat_get_xact_tuples_returned('public.proposals'::regclass)::text as n"
              )
            ).rows[0].n
          );
        const before = await read();
        await owner.query(
          "select public.json_bound_install(array['public.proposals'::regclass])"
        );
        expect((await read()) - before).toBe(0);
        const { rows } = await watcher.query<{ mode: string }>(
          "select mode from pg_locks where pid = $1 and relation = 'public.proposals'::regclass and granted",
          [pid[0].p]
        );
        expect(rows.map((r) => r.mode)).not.toContain("AccessExclusiveLock");
        expect(rows.map((r) => r.mode)).toContain("ShareRowExclusiveLock");
      });
    });
  }
);

dbDescribe(
  "T3: json_bound_lock waits for the application and never aborts it (B-2, RB2-1, TA-a-2, TB-a-3)",
  () => {
    /** A schema of ten small tables of this run's own, made and dropped by the test. */
    const schema = `t3_lk_${process.pid}`;
    const table = (i: number) => `${schema}.t${i}`;
    const list = Array.from({ length: 10 }, (_, i) => `'${table(i)}'::regclass`).join(
      ", "
    );
    beforeAll(async () => {
      if (!DB_ENABLED) return;
      await owner.query(
        `drop schema if exists ${schema} cascade; create schema ${schema}`
      );
      for (let i = 0; i < 10; i++) await owner.query(`create table ${table(i)} (x int)`);
    });
    afterAll(async () => {
      if (!DB_ENABLED) return;
      await owner.query(`drop schema if exists ${schema} cascade`);
    });

    /**
     * The scripted case: H1..H9 each hold one of t1..t9 (ROW EXCLUSIVE, as an application write) and
     * let it go once the helper is seen waiting for it, after a slow-but-free moment; W, an
     * application writer, queues on t0 once the helper holds it. Returns W's wait, in ms, as W's own
     * server measured it around its insert.
     */
    async function scripted(fn: string): Promise<number> {
      const locker = await session();
      const { rows: lp } = await locker.query<{ p: number }>(
        "select pg_backend_pid() as p"
      );
      const holders: Client[] = [];
      for (let i = 1; i < 10; i++) {
        const h = await session();
        await h.query("begin");
        await h.query(`lock table ${table(i)} in row exclusive mode`);
        holders.push(h);
      }
      const lockerIs = (state: "granted" | "waiting", rel: string) => async () =>
        Number(
          (
            await owner.query<{ n: string }>(
              "select count(*)::text as n from pg_locks where pid = $1 and relation = $2::regclass and granted = $3",
              [lp[0].p, rel, state === "granted"]
            )
          ).rows[0].n
        ) > 0;
      await locker.query("begin");
      // deadlock_timeout 1 s: the helper's budget is its cap, 100 ms (half of deadlock_timeout,
      // at most 100 ms), a tenth of what the writer may wait — a stalled runner does not decide
      // this test (code reviews A-12, B-17: the bound was 200 ms against a wait of ~100).
      await locker.query("set local deadlock_timeout = '1s'");
      const lock = locker.query(`select ${fn}(array[${list}])`);
      await until(lockerIs("granted", table(0)));
      const w = await session();
      await w.query(
        `create or replace function pg_temp.t3_timed() returns float8 language plpgsql as $f$
       declare s timestamptz := clock_timestamp();
       begin insert into ${table(0)} values (1); return extract(epoch from clock_timestamp() - s) * 1000; end $f$`
      );
      const waited = w.query<{ ms: number }>("select pg_temp.t3_timed() as ms");
      for (let i = 1; i < 10; i++) {
        await until(lockerIs("waiting", table(i)), 5_000).catch(() => undefined);
        // Slow but free: the holder lets go a moment after the helper is seen waiting for it —
        // longer than one budget, so a helper that keeps its first lock through all nine waits
        // holds it for at least 9 x 250 ms.
        await new Promise((r) => setTimeout(r, 250));
        await holders[i - 1].query("commit");
      }
      await lock;
      await locker.query("rollback");
      const ms = (await waited).rows[0].ms;
      return ms;
    }

    it("(E6) one budget per attempt: the application writer waits less than deadlock_timeout (1 s; the budget is 100 ms)", async () => {
      const ms = await scripted("public.json_bound_lock");
      expect(ms).toBeLessThan(1000);
    }, 60_000);

    it("[without-fix] the mutant with a budget per table keeps the first table past deadlock_timeout", async () => {
      // The previous helper: each table's lock_timeout the whole budget, so an attempt that met
      // several slow tables held its first lock for all of their waits.
      await owner.query(
        `create or replace function ${schema}.per_table_lock(tables regclass[]) returns int language plpgsql as $f$
       declare t regclass; attempts int := 0;
       begin
         loop
           begin
             foreach t in array tables loop
               perform set_config('lock_timeout', '500ms', true);
               execute format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', t);
             end loop;
             return attempts;
           exception when lock_not_available then
             attempts := attempts + 1;
             perform pg_sleep(0.05);
           end;
         end loop;
       end $f$`
      );
      const ms = await scripted(`${schema}.per_table_lock`);
      expect(ms).toBeGreaterThanOrEqual(1000);
    }, 60_000);

    it("(B-2) an application transaction holding a table is waited for, never aborted", async () => {
      const app = await session();
      await app.query("begin");
      await app.query(`insert into ${table(3)} values (1)`);
      const locker = await session();
      const { rows: lp } = await locker.query<{ p: number }>(
        "select pg_backend_pid() as p"
      );
      await locker.query("begin");
      const lock = locker.query<{ n: number }>(
        `select public.json_bound_lock(array[${list}]) as n`
      );
      // Seen waiting for t3, then giving up (its wait gone while it sleeps before the next attempt)
      // while the application still holds it: the helper yields, the application is never aborted.
      const waitingFor3 = async () =>
        Number(
          (
            await owner.query<{ n: string }>(
              "select count(*)::text as n from pg_locks where pid = $1 and relation = $2::regclass and not granted",
              [lp[0].p, table(3)]
            )
          ).rows[0].n
        ) > 0;
      await until(waitingFor3);
      await until(async () => !(await waitingFor3()));
      await app.query(`insert into ${table(3)} values (2)`);
      await app.query("commit");
      const { rows } = await lock;
      await locker.query("rollback");
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
      const { rows: kept } = await owner.query<{ n: number }>(
        `select count(*)::int as n from ${table(3)}`
      );
      expect(kept[0].n).toBe(2);
      await owner.query(`delete from ${table(3)}`);
    }, 60_000);

    it("(RB2-1, TB-a-3) busy for 30 s: fails naming the table, the holder and its transaction's positive age", async () => {
      const app = await session();
      const { rows: ap } = await app.query<{ p: number }>("select pg_backend_pid() as p");
      await app.query("begin");
      await app.query(`insert into ${table(5)} values (1)`);
      const locker = await session();
      await locker.query("begin");
      const err = await locker
        .query(`select public.json_bound_lock(array['${table(5)}'::regclass])`)
        .then(
          () => null,
          (e: { code: string; message: string; hint?: string }) => e
        );
      await locker.query("rollback");
      await app.query("rollback");
      expect(err?.code).toBe("55P03");
      expect(err?.message).toContain(`json bound: ${table(5)} stayed busy for 30 s`);
      // Advice that can be followed on the first paste of 074, when nothing of it exists yet
      // (code review A-8: the hint named a function the failed statement had just rolled back).
      expect(err?.hint).toContain(
        "if this was migration 074 itself, nothing of it exists yet — paste 074 again in a quieter minute"
      );
      expect(err?.hint).toContain(
        "If it was json_bound_install or json_bound_off, run it for that one table"
      );
      expect(err?.message).toMatch(
        new RegExp(
          `pid ${ap[0].p} \\(client backend, [a-z ]+, transaction open (\\d\\d:\\d\\d:\\d\\d)\\)`
        )
      );
      const age = /transaction open (\d\d):(\d\d):(\d\d)/.exec(err?.message ?? "");
      expect(
        age && Number(age[1]) * 3600 + Number(age[2]) * 60 + Number(age[3])
      ).toBeGreaterThan(0);
    }, 90_000);

    it("(TB-a-2) off, install and check per table while four sessions write: no application transaction fails", async () => {
      const writers = await Promise.all([0, 1, 2, 3].map(() => session()));
      let stop = false;
      const failures: string[] = [];
      let done = 0;
      const loops = writers.map(async (c, i) => {
        while (!stop) {
          try {
            await c.query("begin");
            await c.query(`insert into ${table((i % 3) + 6)} values (1)`);
            await c.query(`insert into ${table(((i + 1) % 3) + 6)} values (1)`);
            await c.query("commit");
            done++;
          } catch (e) {
            failures.push((e as { code?: string }).code ?? "?");
            await c.query("rollback").catch(() => undefined);
          }
        }
      });
      // Three of the bound's own tables, off then back, one per call (the runbook's form).
      for (const t of ["public.ai_metrics", "public.groups", "public.jobs"]) {
        await owner.query(`select public.json_bound_off(array['${t}'::regclass])`);
        await owner.query(`select public.json_bound_install(array['${t}'::regclass])`);
        await owner.query(`select public.json_bound_check('${t}')`);
      }
      stop = true;
      await Promise.all(loops);
      expect(failures).toEqual([]);
      expect(done).toBeGreaterThan(0);
      const { rows } = await owner.query<{ m: string }>(
        "select m from public.json_bound_missing() m"
      );
      expect(rows).toEqual([]);
    }, 60_000);
  }
);

dbDescribe(
  "T3: a table whose rows cannot be read stops the check by name (code review A-17)",
  () => {
    const rel = `public.t3_unread_${process.pid}`;
    afterAll(async () => {
      if (!DB_ENABLED) return;
      await owner.query(`drop table if exists ${rel}`);
    });

    it("the read fails (here: the table is locked against reading past the check's 5 s): the table and the server's own reason are named, with the query that finds its largest values", async () => {
      await owner.query(`drop table if exists ${rel}; create table ${rel} (doc jsonb)`);
      await owner.query(`select public.json_bound_install(array['${rel}'::regclass])`);
      const holder = await session();
      await holder.query("begin");
      await holder.query(`lock table ${rel} in access exclusive mode`);
      const err = await owner.query(`select public.json_bound_check('${rel}')`).then(
        () => null,
        (e: { code: string; message: string; hint?: string }) => e
      );
      await holder.query("rollback");
      expect(err?.code).toBe("55P03");
      expect(err?.message).toMatch(
        new RegExp(
          `^json_bound_check: ${rel.replace(".", "\\.")} — its rows could not be read \\(55P03: `
        )
      );
      expect(err?.hint).toContain(
        "select ctid, pg_column_size(<column>) from only <table> order by 2 desc limit 5"
      );
      // Nothing is left half done: the table is still "rows not checked", then reads clean.
      await owner.query(`select public.json_bound_check('${rel}')`);
      await owner.query(`drop table ${rel}`);
    }, 60_000);
  }
);

dbDescribe("T3: 075 reads each table in one scan (RA2-13, RB2-10, B-5, SB-14)", () => {
  const scans = async (rel: string) =>
    Number(
      (
        await owner.query<{ n: string }>(
          "select pg_stat_get_xact_numscans($1::regclass)::text as n",
          [rel]
        )
      ).rows[0].n
    );

  it("proposals (four jsonb columns): one scan; the mutant reading each column alone: four", async () => {
    await rolledBack(owner, async () => {
      const before = await scans("public.proposals");
      await owner.query("select public.json_bound_check('public.proposals')");
      expect((await scans("public.proposals")) - before).toBe(1);
      const mid = await scans("public.proposals");
      for (const col of ["payload", "effects", "decision_shown", "actor_identity"])
        await owner.query(
          `select 1 from only public.proposals where ${col} is not null and jsonb_path_exists(${col}, public.json_bound_depth_path()) limit 1`
        );
      expect((await scans("public.proposals")) - mid).toBe(4);
    });
  });

  it("a partitioned table: each leaf read once, under the parent's bound", async () => {
    await rolledBack(owner, async () => {
      await owner.query(
        "create table public.t3_part (k int, doc jsonb) partition by range (k)"
      );
      await owner.query(
        "create table public.t3_part_a partition of public.t3_part for values from (0) to (10)"
      );
      await owner.query(
        "create table public.t3_part_b partition of public.t3_part for values from (10) to (20)"
      );
      await owner.query(
        "select public.json_bound_install(array['public.t3_part'::regclass])"
      );
      await owner.query("insert into public.t3_part values (1, '{}'), (11, '[1]')");
      const a = await scans("public.t3_part_a");
      const b = await scans("public.t3_part_b");
      await owner.query("select public.json_bound_check('public.t3_part')");
      expect((await scans("public.t3_part_a")) - a).toBe(1);
      expect((await scans("public.t3_part_b")) - b).toBe(1);
      // The parent's triggers are cloned to its partitions: a leaf refuses as the parent does.
      await owner.query("savepoint s");
      const err = await owner
        .query("insert into public.t3_part_b values (12, '[1e-30]')")
        .then(
          () => null,
          (e: { constraint?: string }) => e
        );
      await owner.query("rollback to savepoint s");
      expect(err?.constraint).toBe("json_bound");
    });
  });
});
