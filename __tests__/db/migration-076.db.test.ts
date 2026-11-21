/**
 * @jest-environment node
 */
/**
 * __tests__/db/migration-076.db.test.ts — migration 076 converts the stored steps into rows and
 * clears nothing; pasted again it returns before any lock; its rollback is exact (platform
 * TASK-230, ADR-059; design 56e-3b §2.3, T3)
 *
 * @not-guard: it reads migration 076 and its rollback to paste them as the owner does, and scans nothing.
 *
 * What it refuses: a conversion that loses, reorders or reprints a step; a 076 that, pasted again,
 * takes a lock (and can deadlock with an append — review TB-b-1); a refusal that names the wrong
 * cause (confirmation C-3); an emergency off of the bound on another table switched back on (review
 * TA-b-5); an application transaction aborted by 076's locks; a rollback that loses a step or resets
 * purges it should not (reviews TA-b-6, TB-b-4); 076's readiness missing a changed object
 *
 * This worker's own database is taken back to before 076 by its rollback
 * (supabase/optional/076_rollback.sql), old-format runs are written, and 076 is pasted as the owner
 * pastes it: each file one statement, sent as text. Whatever a test leaves, afterAll applies 076
 * again, so the suites after this one in the worker find the schema as the replay made it.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { withPlatformTx } from "@/platform/data";
import {
  missingErasureFunctions,
  missingJsonBound,
} from "@/platform/auth/erasure-schema";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const ROOT = join(__dirname, "..", "..");
const M076 = readFileSync(
  join(ROOT, "supabase", "migrations", "076_trajectory_steps_as_rows.sql"),
  "utf8"
);
const ROLLBACK = readFileSync(
  join(ROOT, "supabase", "optional", "076_rollback.sql"),
  "utf8"
);

let owner: Client;
const opened: Client[] = [];

async function connect(as: "owner" | "app", tenant?: string): Promise<Client> {
  const c = new Client({
    connectionString:
      as === "owner"
        ? process.env.TEST_DATABASE_OWNER_URL
        : process.env.TEST_DATABASE_URL,
  });
  await c.connect();
  if (tenant) await c.query("select set_config('app.tenant_id', $1, false)", [tenant]);
  opened.push(c);
  return c;
}

const one = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await owner.query(sql, values)).rows[0] as T;

const hasOldColumn = async () =>
  (
    await one<{ n: number }>(
      "select count(*)::int as n from pg_attribute where attrelid = 'public.agent_trajectories'::regclass and attname = 'steps' and not attisdropped"
    )
  ).n === 1;

const recorded = async () =>
  (
    await one<{ n: number }>(
      "select count(*)::int as n from applied_migrations where filename = '076_trajectory_steps_as_rows.sql'"
    )
  ).n === 1;

/** 076's readiness lines (empty: everything as 076 makes it). */
const stepsMissing = async (): Promise<string[]> =>
  (
    await owner.query("select m from public.trajectory_steps_missing() m order by 1")
  ).rows.map((r) => r.m as string);

/** Back to before 076 (the rollback), when it is applied. */
async function rolledBack(): Promise<void> {
  await owner.query(ROLLBACK);
  expect(await hasOldColumn()).toBe(true);
}

/** 076 applied, recorded, in force. */
async function applied(): Promise<void> {
  await owner.query(M076);
  expect(await hasOldColumn()).toBe(false);
  expect(await recorded()).toBe(true);
  expect(await stepsMissing()).toEqual([]);
}

/** Each test stands alone (it may be run alone): the state it starts from, made if need be. */
async function asBefore076(): Promise<void> {
  if (!(await hasOldColumn())) await rolledBack();
}
async function asAfter076(): Promise<void> {
  if ((await hasOldColumn()) || !(await recorded())) await applied();
}

/** Poll until backend `pid` waits on a lock or sleeps between lock attempts (bounded). */
async function untilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 4000; i++) {
    const r = await one<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where pid = $1 and (wait_event_type = 'Lock' or wait_event = 'PgSleep')`,
      [pid]
    );
    if (r.n > 0) return;
    await new Promise((res) => setImmediate(res));
  }
  throw new Error(`backend ${pid} was never blocked`);
}

let t: TestTenant;
/** Old-format runs of this file: id → their steps as stored, printed. */
const preImage = new Map<string, string>();

/** Each suite below: the database, a tenant and the owner's connection; 076 as the replay left it. */
function migrationHooks(): void {
  beforeAll(async () => {
    await connectTestDatabase();
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
    t = await createTestTenant();
  });

  afterAll(async () => {
    for (const c of opened) await c.end().catch(() => undefined);
    // Whatever happened above, the worker's database leaves as the replay made it.
    await owner.query("rollback").catch(() => undefined);
    if (!(await recorded()) || (await hasOldColumn())) await owner.query(M076);
    await owner.end();
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

/** An old-format run of `t` holding `steps` (raw JSON text), its id. */
async function oldRun(
  steps: string,
  chain?: { previous: string; segment: number; offset: number }
) {
  const id = randomUUID();
  await owner.query(
    chain
      ? `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type, steps, segment, previous_trajectory_id, step_offset)
       values ($1::uuid, $2::uuid, 't76', 'agent', 'old', 'platform', $3::jsonb, $4::int, $5::uuid, $6::int)`
      : `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type, steps)
       values ($1::uuid, $2::uuid, 't76', 'agent', 'old', 'platform', $3::jsonb)`,
    chain
      ? [id, t.id, steps, chain.segment, chain.previous, chain.offset]
      : [id, t.id, steps]
  );
  preImage.set(
    id,
    (
      await one<{ s: string }>(
        "select steps::text as s from agent_trajectories where id = $1::uuid",
        [id]
      )
    ).s
  );
  return id;
}

dbDescribe(
  "T3: migration 076 and its rollback, as the owner pastes them (TASK-230)",
  () => {
    migrationHooks();

    it("the rollback takes the database back to one document per run: the column, 052's guard, 074's exception", async () => {
      await rolledBack();
      expect(await recorded()).toBe(false);
      expect(
        await one("select to_regclass('public.agent_trajectory_steps') is null as gone")
      ).toEqual({
        gone: true,
      });
      expect(
        await one(
          "select public.json_bound_limit('public.agent_trajectories'::regclass, 'steps') as lim"
        )
      ).toEqual({ lim: "0" });
      expect(
        (await owner.query("select m from public.json_bound_missing() m")).rows
      ).toEqual([]);
      expect(
        await one(
          "select 'agent_trajectory_steps' = any (table_names) as listed from deletion_manifest where module_name = 'platform'"
        )
      ).toEqual({ listed: false });
    });

    it("refusals name their own cause; nothing is changed (C-3: the role's sight first)", async () => {
      await asBefore076();
      // A role that cannot see every row: told so — not that 074 and 075 are missing.
      const app = await connect("app", t.id);
      await expect(app.query(M076)).rejects.toThrow(/cannot see every row/);
      // 075 not recorded: refused (in a transaction rolled back, so the record stays).
      await owner.query("begin");
      try {
        await owner.query(
          "delete from applied_migrations where filename = '075_json_bound_existing_rows.sql'"
        );
        await expect(owner.query(M076)).rejects.toThrow(
          /074 and 075 are not both applied/
        );
      } finally {
        await owner.query("rollback");
      }
      // A stored step over the JSON bound (a number outside the range, accepted by the old
      // column's depth-only bound): 076 stops naming it — the trajectory and its place — and
      // changes nothing.
      const bad = await oldRun('[{"ok": 1}, {"n": 1e25}]');
      try {
        await expect(owner.query(M076)).rejects.toThrow(
          new RegExp(
            `agent_trajectory_steps\\.step: it holds a number other than 0[^\\n]*row \\([^,]+, ${bad}, 1\\)`
          )
        );
        expect(await hasOldColumn()).toBe(true);
        expect(await recorded()).toBe(false);
        expect(
          await one("select to_regclass('public.agent_trajectory_steps') is null as gone")
        ).toEqual({
          gone: true,
        });
      } finally {
        await owner.query("delete from agent_trajectories where id = $1::uuid", [bad]);
        preImage.delete(bad);
      }
    });

    it("converts every stored step: same steps, same order, same text; counters; continued; a non-array kept", async () => {
      await asBefore076();
      const specials =
        '[null, {}, [], 1.0, 1.50, -0, 0.0, 1e-18, 123456789012345678901e-1, "é€😀", "tab\\there", ' +
        '{"z": 1, "a": 2, "aa": 3, "a": 4}, {"k": null}, {"deep": ' +
        "[".repeat(120) +
        "1" +
        "]".repeat(120) +
        "}]";
      const plain = await oldRun(specials);
      const empty = await oldRun("[]");
      const nonArray = await oldRun('{"a": 1, "b": [1, 2]}');
      const s1 = await oldRun(
        '[{"stepIndex": 0, "to": "ann@x.test"}, {"stepIndex": 1, "ann@x.test": 1e-18}]'
      );
      const s2 = await oldRun('[{"stepIndex": 2}]', {
        previous: s1,
        segment: 2,
        offset: 2,
      });
      // A chain whose first segment is empty and continued.
      const e1 = await oldRun("[]");
      const e2 = await oldRun('[{"stepIndex": 0}]', {
        previous: e1,
        segment: 2,
        offset: 0,
      });

      // A reader of the trajectories is blocked for the whole conversion; it reads after it.
      const reader = await connect("owner");
      await owner.query(M076);
      expect(await hasOldColumn()).toBe(false);
      expect(await recorded()).toBe(true);
      expect(await stepsMissing()).toEqual([]);
      expect(
        (await owner.query("select m from public.json_bound_missing() m")).rows
      ).toEqual([]);
      expect(
        (
          await reader.query(
            "select count(*)::int as n from agent_trajectories where trigger = 't76'"
          )
        ).rows[0].n
      ).toBe(preImage.size);

      for (const [id, printed] of preImage) {
        const row = await one<{
          rebuilt: string | null;
          n: number;
          b: string;
          count: number;
          bytes: string;
        }>(
          `select (select jsonb_agg(s.step order by s.seq)::text from agent_trajectory_steps s where s.trajectory_id = t.id) as rebuilt,
                (select count(*)::int from agent_trajectory_steps s where s.trajectory_id = t.id) as n,
                (select coalesce(sum(octet_length(s.step::text)), 0)::text from agent_trajectory_steps s where s.trajectory_id = t.id) as b,
                t.step_count as count, t.steps_bytes::text as bytes
           from agent_trajectories t where t.id = $1::uuid`,
          [id]
        );
        const expected = id === nonArray ? `[${printed}]` : printed;
        // As text: every number, key order and escape printed as it was stored.
        expect([id, row.rebuilt ?? "[]"]).toEqual([id, expected]);
        expect([row.count, row.bytes]).toEqual([row.n, row.b]);
      }
      const flags = await owner.query(
        "select id, continued from agent_trajectories where id = any($1::uuid[])",
        [[plain, empty, nonArray, s1, s2, e1, e2]]
      );
      expect(Object.fromEntries(flags.rows.map((r) => [r.id, r.continued]))).toEqual({
        [plain]: false,
        [empty]: false,
        [nonArray]: false,
        [s1]: true,
        [s2]: false,
        [e1]: true,
        [e2]: false,
      });
      expect(
        await one(
          "select 'agent_trajectory_steps' = any (table_names) as listed from deletion_manifest where module_name = 'platform'"
        )
      ).toEqual({ listed: true });
    });

    it("(TB-b-1) pasted again while an append holds its locks: returns at once, takes no lock, changes nothing", async () => {
      await asAfter076();
      const app = await connect("app", t.id);
      const run = randomUUID();
      await owner.query(
        `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type)
       values ($1::uuid, $2::uuid, 't76', 'agent', 'again', 'platform')`,
        [run, t.id]
      );
      const before = await one<{ at: Date }>(
        "select recorded_at as at from applied_migrations where filename = '076_trajectory_steps_as_rows.sql'"
      );
      await app.query("begin");
      await app.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step) values ($1::uuid, $2::uuid, 0, '{"k": 1}')`,
        [t.id, run]
      );
      // The append's transaction is open, holding ROW EXCLUSIVE on both tables. A 076 that took a
      // table lock would wait (and give up after 30 s); this one returns.
      await owner.query(M076);
      await app.query("commit");
      expect(
        await one<{ at: Date }>(
          "select recorded_at as at from applied_migrations where filename = '076_trajectory_steps_as_rows.sql'"
        )
      ).toEqual(before);
      expect(await stepsMissing()).toEqual([]);
    });

    it("(SA-7, SB-2) pasted again with one of its objects not in force: repairs it, converts nothing, every step as it was", async () => {
      await asAfter076();
      const own = randomUUID();
      await owner.query(
        `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type)
         values ($1::uuid, $2::uuid, 't76', 'agent', 'repair', 'platform')`,
        [own, t.id]
      );
      await owner.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step) values ($1::uuid, $2::uuid, 0, '{"k": "kept"}')`,
        [t.id, own]
      );
      const steps = async () =>
        await one<{ h: string; n: number }>(
          "select md5(coalesce(string_agg(trajectory_id::text || ':' || seq || ':' || step::text, ',' order by trajectory_id, seq), '')) as h, count(*)::int as n from agent_trajectory_steps"
        );
      const before = await steps();
      expect(before.n).toBeGreaterThan(0);
      await owner.query("grant delete on agent_trajectory_steps to app_tenant");
      expect(await stepsMissing()).toEqual([
        "public.agent_trajectory_steps: app_tenant may DELETE",
      ]);
      // Not everything in force: 076 runs through — and, the old column gone, converts nothing.
      await owner.query(M076);
      expect(await stepsMissing()).toEqual([]);
      expect(await steps()).toEqual(before);
    });
  }
);

dbDescribe(
  "T3: migration 076 beside other objects, readiness and the rollback's window (TASK-230)",
  () => {
    migrationHooks();

    it("(TA-b-5) an emergency off of the bound on another table is left off by 076", async () => {
      await rolledBack();
      await owner.query(
        "select public.json_bound_off(array['public.audit_log'::regclass])"
      );
      try {
        await applied();
        const lines = (
          await owner.query("select m from public.json_bound_missing() m")
        ).rows.map((r) => r.m as string);
        expect(lines.some((l) => /^public\.audit_log: .*the bound is off/.test(l))).toBe(
          true
        );
      } finally {
        await owner.query(
          "select public.json_bound_install(array['public.audit_log'::regclass])"
        );
        await owner.query("select public.json_bound_check('public.audit_log'::regclass)");
      }
      expect(
        (await owner.query("select m from public.json_bound_missing() m")).rows
      ).toEqual([]);
    });

    it("an application transaction holding a trajectory while 076 converts is never aborted: 076 yields and waits", async () => {
      await rolledBack();
      const run = await oldRun('[{"k": "held"}]');
      const app = await connect("owner");
      await app.query("begin");
      await app.query("select 1 from agent_trajectories where id = $1::uuid for update", [
        run,
      ]);
      const m = await connect("owner");
      const pid = (await m.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const migrating = m.query(M076);
      await untilBlocked(pid);
      // The application goes on in its transaction, and commits.
      await app.query(
        "update agent_trajectories set updated_at = now() where id = $1::uuid",
        [run]
      );
      await app.query("commit");
      await migrating;
      expect(await recorded()).toBe(true);
      expect(await stepsMissing()).toEqual([]);
    });

    it("readiness names what is not as 076 makes it; the erasure's gate refuses only on 076 itself missing", async () => {
      await asAfter076();
      const gate = () => withPlatformTx((tx) => missingErasureFunctions(tx));
      const probe = () => withPlatformTx((tx) => missingJsonBound(tx));
      expect(await gate()).toEqual([]);
      expect(await probe()).toEqual([]);
      // (TA-b-7) A BEFORE trigger that fires after the guard could change a step after it was measured.
      await owner.query(
        "create function pg_temp.noop() returns trigger language plpgsql as $f$ begin return new; end $f$"
      );
      await owner.query(
        "create trigger zya_after_guard before insert on agent_trajectory_steps for each row execute function pg_temp.noop()"
      );
      try {
        expect(await stepsMissing()).toEqual([
          "public.agent_trajectory_steps: trigger zya_after_guard fires after zy_agent_trajectory_steps_guard",
        ]);
        expect(await probe()).toContain(
          "public.agent_trajectory_steps: trigger zya_after_guard fires after zy_agent_trajectory_steps_guard"
        );
        expect(await gate()).toEqual([]);
      } finally {
        await owner.query("drop trigger zya_after_guard on agent_trajectory_steps");
      }
      // A right beyond 076's.
      await owner.query("grant delete on agent_trajectory_steps to app_tenant");
      try {
        expect(await stepsMissing()).toEqual([
          "public.agent_trajectory_steps: app_tenant may DELETE",
        ]);
      } finally {
        await owner.query("revoke delete on agent_trajectory_steps from app_tenant");
      }
      // The guard's function changed.
      const def = (
        await one<{ d: string }>(
          "select pg_get_functiondef('public.agent_trajectory_steps_guard()'::regprocedure) as d"
        )
      ).d;
      await owner.query(
        def.replace("if parent.continued then", "if parent.continued and false then")
      );
      try {
        expect(await stepsMissing()).toEqual([
          "public.agent_trajectory_steps_guard(): not as migration 076 makes it",
        ]);
      } finally {
        await owner.query(def);
      }
      expect(await stepsMissing()).toEqual([]);
      // 076 not recorded: the gate refuses (line 1), in a transaction rolled back.
      await owner.query("begin");
      try {
        await owner.query(
          "delete from applied_migrations where filename = '076_trajectory_steps_as_rows.sql'"
        );
        expect(
          (
            await owner.query(
              `select coalesce(array_agg(m order by m), '{}') as missing from public.trajectory_steps_missing() m
              where m like '076_trajectory_steps_as_rows.sql: %' or m like '%: missing' or m like 'agent_trajectories.steps: %'`
            )
          ).rows[0].missing
        ).toEqual(["076_trajectory_steps_as_rows.sql: not recorded"]);
      } finally {
        await owner.query("rollback");
      }
    });

    it("(TA-b-6, TB-b-4) the rollback is exact and resets only the purges 076's window failed; twice changes nothing", async () => {
      await asAfter076();
      // Steps written through the rows now, with a continuation.
      const first = randomUUID();
      await owner.query(
        `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type)
       values ($1::uuid, $2::uuid, 't76r', 'agent', 'rb', 'platform')`,
        [first, t.id]
      );
      await owner.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       values ($1::uuid, $2::uuid, 0, '{"b": 1.50}'), ($1::uuid, $2::uuid, 1, '"two"')`,
        [t.id, first]
      );
      await owner.query(
        `insert into agent_trajectories (tenant_id, trigger, subject_kind, subject_id, scope_type, segment, previous_trajectory_id, step_offset)
       values ($1::uuid, 't76r', 'agent', 'rb', 'platform', 2, $2::uuid, 2)`,
        [t.id, first]
      );
      const at = (
        await one<{ at: string }>(
          "select recorded_at::text as at from applied_migrations where filename = '076_trajectory_steps_as_rows.sql'"
        )
      ).at;
      // A: deferred before 076 (its last attempt before it was recorded) — keeps its attempts.
      // B: one attempt inside the window — due, uncounted, its error cleared.
      // C: three attempts, the last inside the window — due, two left, its error kept.
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      await owner.query(
        `insert into user_deletions (tenant_id, user_id, requested_by, purge_attempts, purge_retry_at, last_purge_error)
       values ($1::uuid, $2::uuid, 'test', 2, $5::timestamptz - interval '1 minute' + interval '2 hours', 'before'),
              ($1::uuid, $3::uuid, 'test', 1, now() + interval '1 hour', 'inside'),
              ($1::uuid, $4::uuid, 'test', 3, now() + interval '4 hours', 'inside, third')`,
        [t.id, a, b, c, at]
      );
      await owner.query(ROLLBACK);
      expect(await hasOldColumn()).toBe(true);
      const rows = await owner.query(
        "select id, segment, steps::text as steps from agent_trajectories where trigger = 't76r' order by segment"
      );
      expect(rows.rows.map((r) => r.steps)).toEqual(['[{"b": 1.50}, "two"]', "[]"]);
      const deletions = await owner.query(
        "select user_id, purge_attempts, purge_retry_at is null as due, last_purge_error from user_deletions where user_id = any($1::uuid[])",
        [[a, b, c]]
      );
      expect(
        Object.fromEntries(
          deletions.rows.map((r) => [
            r.user_id,
            [r.purge_attempts, r.due, r.last_purge_error],
          ])
        )
      ).toEqual({
        [a]: [2, false, "before"],
        [b]: [0, true, null],
        [c]: [2, true, "inside, third"],
      });
      // Twice: nothing changes.
      const snapshot = await owner.query(
        "select id, steps::text, version from agent_trajectories where tenant_id = $1::uuid order by id",
        [t.id]
      );
      await owner.query(ROLLBACK);
      expect(
        (
          await owner.query(
            "select id, steps::text, version from agent_trajectories where tenant_id = $1::uuid order by id",
            [t.id]
          )
        ).rows
      ).toEqual(snapshot.rows);
      await owner.query("delete from user_deletions where user_id = any($1::uuid[])", [
        [a, b, c],
      ]);
      // And 076 after it: the same rows again.
      await applied();
      const back = await owner.query(
        `select s.seq, s.step::text as step from agent_trajectory_steps s where s.trajectory_id = $1::uuid order by s.seq`,
        [first]
      );
      expect(back.rows).toEqual([
        { seq: 0, step: '{"b": 1.50}' },
        { seq: 1, step: '"two"' },
      ]);
      expect(
        await one("select continued from agent_trajectories where id = $1::uuid", [first])
      ).toEqual({ continued: true });
    });

    it("(SB-10 (6)) the steps' storage is counted: what 40 steps of 6 KB add is their text, not a second copy", async () => {
      await asAfter076();
      const run = randomUUID();
      await owner.query(
        `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type)
       values ($1::uuid, $2::uuid, 't76s', 'agent', 'size', 'platform')`,
        [run, t.id]
      );
      const size = async () =>
        Number(
          (
            await one<{ n: string }>(
              "select pg_total_relation_size('public.agent_trajectory_steps')::text as n"
            )
          ).n
        );
      const before = await size();
      // Text that does not compress (md5 chained): what is stored is what is printed.
      await owner.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       select $1::uuid, $2::uuid, i,
              jsonb_build_object('text', (select string_agg(md5(i::text || ':' || j::text), '') from generate_series(1, 187) j))
         from generate_series(0, 39) i order by i`,
        [t.id, run]
      );
      const printed = Number(
        (
          await one<{ n: string }>(
            "select sum(octet_length(step::text))::text as n from agent_trajectory_steps where trajectory_id = $1::uuid",
            [run]
          )
        ).n
      );
      expect(printed).toBeGreaterThan(40 * 5_900);
      expect((await size()) - before).toBeLessThanOrEqual(1.25 * printed + 16 * 8192);
    });
  }
);
