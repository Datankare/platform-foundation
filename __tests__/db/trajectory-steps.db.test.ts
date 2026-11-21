/**
 * @jest-environment node
 */
/**
 * __tests__/db/trajectory-steps.db.test.ts — a trajectory's steps are rows, and the database keeps
 * every rule of them, whoever writes (platform TASK-230, ADR-059; design 56e-3b §2.2, T1)
 *
 * What it refuses: a step written out of order, past a segment's limits, into a continued segment, for
 * another tenant's trajectory, moved, deleted while its trajectory stands, or counters set by hand —
 * by app_tenant and by the owner alike; and a tenant purge that cannot delete a deleted tenant's
 * steps (confirmation CB3-1)
 *
 * Migration 076's step trigger (zy_agent_trajectory_steps_guard, ENABLE ALWAYS) is driven here
 * directly in SQL — as app_tenant (the platform's role) and as the owner — so what is proved is the
 * database's rule, not the store's politeness. Every scenario ends by reading the counters against
 * the rows.
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const MIB = 1_048_576;

let owner: Client;
const apps: Client[] = [];

/** A connection as app_tenant in `tenant` (autocommit; each statement its own transaction). */
async function app(tenant: string): Promise<Client> {
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  await c.query("select set_config('app.tenant_id', $1, false)", [tenant]);
  apps.push(c);
  return c;
}

/** A trajectory of `tenant` (as the owner), its id. */
async function trajectory(tenant: string, extra = ""): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type${extra ? ", segment, previous_trajectory_id, step_offset" : ""})
     values ($1::uuid, $2::uuid, 't', 'agent', 'steps-test', 'platform'${extra})`,
    [id, tenant]
  );
  return id;
}

/** The trajectory's counters and the rows' own count and printed bytes. */
async function counters(id: string) {
  const { rows } = await owner.query(
    `select t.step_count, t.steps_bytes::bigint as steps_bytes, t.continued, t.version,
            (select count(*)::int from agent_trajectory_steps s where s.trajectory_id = t.id) as rows,
            (select coalesce(sum(octet_length(s.step::text)), 0)::bigint from agent_trajectory_steps s
              where s.trajectory_id = t.id) as printed
       from agent_trajectories t where t.id = $1::uuid`,
    [id]
  );
  const r = rows[0];
  return {
    stepCount: Number(r.step_count),
    stepsBytes: Number(r.steps_bytes),
    continued: r.continued as boolean,
    version: Number(r.version),
    rows: Number(r.rows),
    printed: Number(r.printed),
  };
}

/** Counters equal the rows (the invariant every scenario ends on). */
async function expectCountersTrue(id: string): Promise<void> {
  const c = await counters(id);
  expect([c.stepCount, c.stepsBytes]).toEqual([c.rows, c.printed]);
}

const insertStep = (
  c: Client,
  tenant: string,
  id: string,
  seq: number,
  step = '{"k": 1}'
) =>
  c.query(
    "insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step) values ($1::uuid, $2::uuid, $3::int, $4::jsonb)",
    [tenant, id, seq, step]
  );

let t: TestTenant;
let other: TestTenant;

/** Each suite below: the database, two tenants and the owner's connection. */
function stepHooks(): void {
  beforeAll(async () => {
    await connectTestDatabase();
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
    t = await createTestTenant();
    other = await createTestTenant();
  });

  afterAll(async () => {
    for (const c of apps) await c.end();
    await owner.end();
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

dbDescribe(
  "T1: a trajectory's steps are rows and the database keeps their rules (TASK-230)",
  () => {
    stepHooks();

    it("appends in order only: the next place, never a gap, never an overwrite (app_tenant and owner)", async () => {
      const id = await trajectory(t.id);
      const a = await app(t.id);
      await insertStep(a, t.id, id, 0);
      await expect(insertStep(a, t.id, id, 2)).rejects.toMatchObject({
        code: "23514",
        constraint: "trajectory_step_order",
      });
      await expect(insertStep(a, t.id, id, 0)).rejects.toMatchObject({
        code: "23514",
        constraint: "trajectory_step_order",
      });
      // ON CONFLICT DO UPDATE onto a taken place is an insert first: refused the same way.
      await expect(
        a.query(
          `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
         values ($1::uuid, $2::uuid, 0, '{"k": 9}') on conflict (tenant_id, trajectory_id, seq)
         do update set step = excluded.step`,
          [t.id, id]
        )
      ).rejects.toMatchObject({ code: "23514", constraint: "trajectory_step_order" });
      await expect(insertStep(owner, t.id, id, 5)).rejects.toMatchObject({
        constraint: "trajectory_step_order",
      });
      // Several rows in one statement, in order, are several appends.
      await a.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       values ($1::uuid, $2::uuid, 1, '{"k": 2}'), ($1::uuid, $2::uuid, 2, '{"k": 3}')`,
        [t.id, id]
      );
      expect((await counters(id)).stepCount).toBe(3);
      await expectCountersTrue(id);
    });

    it("every append moves the counters and the version; a new trajectory starts at 0/0, not continued", async () => {
      const id = await trajectory(t.id);
      const before = await counters(id);
      expect(before).toMatchObject({ stepCount: 0, stepsBytes: 0, continued: false });
      await insertStep(owner, t.id, id, 0, '{"text": "héllo"}');
      const after = await counters(id);
      expect(after.version).toBe(before.version + 1);
      expect(after.stepsBytes).toBe(Buffer.byteLength('{"text": "héllo"}', "utf8"));
      await expect(
        owner.query(
          `insert into agent_trajectories (tenant_id, trigger, subject_kind, subject_id, step_count)
         values ($1::uuid, 't', 'agent', 'x', 3)`,
          [t.id]
        )
      ).rejects.toThrow(/starts with no steps/);
    });

    it("a continued segment takes no step: its steps go to the chain's last segment", async () => {
      const first = await trajectory(t.id);
      await insertStep(owner, t.id, first, 0);
      await trajectory(t.id, `, 2, '${first}'::uuid, 1`);
      expect((await counters(first)).continued).toBe(true);
      const a = await app(t.id);
      await expect(insertStep(a, t.id, first, 1)).rejects.toMatchObject({
        code: "23514",
        constraint: "trajectory_continued",
      });
      await expect(insertStep(owner, t.id, first, 1)).rejects.toMatchObject({
        constraint: "trajectory_continued",
      });
      await expectCountersTrue(first);
    });

    it(`a segment is full at 1 000 steps: the 1 001st is refused (trajectory_full)`, async () => {
      const id = await trajectory(t.id);
      await owner.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       select $1::uuid, $2::uuid, i, jsonb_build_object('i', i) from generate_series(0, 999) i order by i`,
        [t.id, id]
      );
      const a = await app(t.id);
      await expect(insertStep(a, t.id, id, 1000)).rejects.toMatchObject({
        code: "23514",
        constraint: "trajectory_full",
      });
      expect((await counters(id)).stepCount).toBe(1000);
      await expectCountersTrue(id);
    });

    it("a segment is full at 16 MiB of text as printed: an append past it is refused, nothing changed", async () => {
      const id = await trajectory(t.id);
      const big = (n: number) => `{"blob": "${"x".repeat(n)}"}`;
      await insertStep(owner, t.id, id, 0, big(6 * MIB));
      await insertStep(owner, t.id, id, 1, big(6 * MIB));
      const before = await counters(id);
      await expect(insertStep(owner, t.id, id, 2, big(6 * MIB))).rejects.toMatchObject({
        code: "23514",
        constraint: "trajectory_full",
      });
      expect(await counters(id)).toEqual(before);
      // What fits still goes in.
      await insertStep(owner, t.id, id, 2, big(1024));
      await expectCountersTrue(id);
    });

    it("(TA-b-2) one step over the JSON bound (8 MiB of text) is refused on update: json_bound", async () => {
      const id = await trajectory(t.id);
      await insertStep(owner, t.id, id, 0);
      await expect(
        owner.query(
          "update agent_trajectory_steps set step = to_jsonb(repeat('y', $2::int)) where trajectory_id = $1::uuid",
          [id, 8 * MIB]
        )
      ).rejects.toMatchObject({ code: "23514", constraint: "json_bound" });
      await expectCountersTrue(id);
    });

    it("(TA-b-2) a rewrite that would take the segment past 128 MiB is refused (trajectory_full); a shrink is not", async () => {
      // The segment brought to 128 MiB less 100 bytes by its counter alone — set the one way the
      // chain guard allows nobody to (session_replication_role = replica skips it, as a hand-made
      // row could; the step trigger is ALWAYS and is not skipped). The real reproduction (20 steps
      // grown to 7 MiB each, 146 800 820 bytes accepted before the fix) is the design's
      // (proto final/b2-after.out); here the edge is exact and costs nothing.
      const id = await trajectory(t.id);
      await insertStep(owner, t.id, id, 0, '{"a": "short"}');
      await owner.query("begin");
      await owner.query("set local session_replication_role = replica");
      await owner.query(
        "update agent_trajectories set steps_bytes = 134217728 - 100 where id = $1::uuid",
        [id]
      );
      await owner.query("commit");
      const before = await counters(id);
      await expect(
        owner.query(
          "update agent_trajectory_steps set step = to_jsonb(repeat('z', 200)) where trajectory_id = $1::uuid",
          [id]
        )
      ).rejects.toMatchObject({ code: "23514", constraint: "trajectory_full" });
      expect(await counters(id)).toEqual(before);
      await owner.query(
        `update agent_trajectory_steps set step = '{"a": "s"}'::jsonb where trajectory_id = $1::uuid`,
        [id]
      );
      const after = await counters(id);
      expect(after.stepsBytes).toBe(before.stepsBytes - 4);
      expect(after.version).toBe(before.version + 1);
    });
  }
);

dbDescribe(
  "T1: a step stays where it is put, in its tenant, with its rights (TASK-230)",
  () => {
    stepHooks();

    it("a step never moves: its tenant, trajectory and place stay (owner); app_tenant may update the step only", async () => {
      const id = await trajectory(t.id);
      const two = await trajectory(t.id);
      await insertStep(owner, t.id, id, 0);
      for (const set of [
        "seq = 1",
        `trajectory_id = '${two}'::uuid`,
        `tenant_id = '${other.id}'::uuid`,
      ])
        await expect(
          owner.query(
            `update agent_trajectory_steps set ${set} where trajectory_id = $1::uuid`,
            [id]
          )
        ).rejects.toMatchObject({ code: "23514", constraint: "trajectory_step_fixed" });
      const a = await app(t.id);
      for (const set of [
        "seq = 1",
        "created_at = now()",
        `trajectory_id = '${two}'::uuid`,
      ])
        await expect(
          a.query(
            `update agent_trajectory_steps set ${set} where trajectory_id = $1::uuid`,
            [id]
          )
        ).rejects.toMatchObject({ code: "42501" });
      await a.query(
        `update agent_trajectory_steps set step = '{"k": "rewritten"}' where trajectory_id = $1::uuid`,
        [id]
      );
      await expectCountersTrue(id);
    });

    it("the counters and continued are the triggers' alone: set by hand, refused (owner and app_tenant)", async () => {
      const id = await trajectory(t.id);
      await insertStep(owner, t.id, id, 0);
      const a = await app(t.id);
      for (const c of [owner, a]) {
        await expect(
          c.query("update agent_trajectories set step_count = 0 where id = $1::uuid", [
            id,
          ])
        ).rejects.toThrow(/kept by the steps' own trigger/);
        await expect(
          c.query("update agent_trajectories set steps_bytes = 1 where id = $1::uuid", [
            id,
          ])
        ).rejects.toThrow(/kept by the steps' own trigger/);
        await expect(
          c.query("update agent_trajectories set continued = true where id = $1::uuid", [
            id,
          ])
        ).rejects.toThrow(/continued is set by the continuation/);
      }
      await expectCountersTrue(id);
    });

    it("a step is deleted only with its trajectory: app_tenant may not delete; the owner is refused", async () => {
      const id = await trajectory(t.id);
      await insertStep(owner, t.id, id, 0);
      const a = await app(t.id);
      await expect(
        a.query("delete from agent_trajectory_steps where trajectory_id = $1::uuid", [id])
      ).rejects.toMatchObject({ code: "42501" });
      await expect(a.query("truncate agent_trajectory_steps")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        owner.query("delete from agent_trajectory_steps where trajectory_id = $1::uuid", [
          id,
        ])
      ).rejects.toMatchObject({ code: "23514", constraint: "trajectory_step_kept" });
      // The trajectory's delete takes them (the foreign key's cascade runs inside a trigger).
      await owner.query("delete from agent_trajectories where id = $1::uuid", [id]);
      expect(
        (
          await owner.query(
            "select count(*)::int as n from agent_trajectory_steps where trajectory_id = $1::uuid",
            [id]
          )
        ).rows[0].n
      ).toBe(0);
    });

    it("a step never attaches to another tenant's trajectory (app_tenant and owner)", async () => {
      const theirs = await trajectory(other.id);
      const a = await app(t.id);
      // Its own tenant by default: the trajectory is not there.
      await expect(
        a.query(
          "insert into agent_trajectory_steps (trajectory_id, seq, step) values ($1::uuid, 0, '{}')",
          [theirs]
        )
      ).rejects.toMatchObject({ code: "23503" });
      // Naming the other tenant: the step trigger, reading under row-level security, finds no
      // such trajectory (before the policy's own check could refuse it).
      await expect(insertStep(a, other.id, theirs, 0)).rejects.toMatchObject({
        code: "23503",
      });
      // The owner, naming this tenant for the other's trajectory: the key carries the tenant.
      await expect(insertStep(owner, t.id, theirs, 0)).rejects.toMatchObject({
        code: "23503",
      });
      // And the other tenant's steps are not visible to this one.
      await insertStep(owner, other.id, theirs, 0);
      expect(
        (
          await a.query(
            "select count(*)::int as n from agent_trajectory_steps where trajectory_id = $1::uuid",
            [theirs]
          )
        ).rows[0].n
      ).toBe(0);
    });

    it("the API's roles have no right on the steps; app_tenant reads, appends and rewrites the step only", async () => {
      const { rows } = await owner.query<{ r: string; p: string; has: boolean }>(
        `select x.r, x.p, has_table_privilege(x.r, 'public.agent_trajectory_steps', x.p) as has
         from (values ('anon'), ('authenticated'), ('service_role')) r(r)
        cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('TRIGGER')) p(p)
        cross join lateral (select r.r, p.p) x
        where to_regrole(x.r) is not null`
      );
      expect(rows.filter((r) => r.has)).toEqual([]);
      const { rows: app_ } = await owner.query<{ p: string; has: boolean }>(
        `select p.p, has_table_privilege('app_tenant', 'public.agent_trajectory_steps', p.p) as has
         from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(p) order by 1`
      );
      expect(Object.fromEntries(app_.map((r) => [r.p, r.has]))).toEqual({
        DELETE: false,
        INSERT: true,
        SELECT: true,
        TRUNCATE: false,
        // No table-wide UPDATE: the step column's alone (below).
        UPDATE: false,
      });
      const { rows: cols } = await owner.query<{ a: string }>(
        `select a.attname as a from pg_attribute a
        where a.attrelid = 'public.agent_trajectory_steps'::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege('app_tenant', a.attrelid, a.attnum, 'UPDATE') order by 1`
      );
      expect(cols.map((c) => c.a)).toEqual(["step"]);
    });

    it("(CB3-1) a deleted tenant's purge deletes its steps before its trajectories; an active tenant's step stays", async () => {
      const gone = await createTestTenant();
      const first = await trajectory(gone.id);
      await insertStep(owner, gone.id, first, 0);
      await insertStep(owner, gone.id, first, 1);
      await trajectory(gone.id, `, 2, '${first}'::uuid, 2`);
      // 049's order: the steps table is a leaf of the trajectories' foreign key, deleted first.
      const { rows: order } = await owner.query<{ table_name: string }>(
        "select table_name from public.tenant_tables() where table_name in ('agent_trajectory_steps', 'agent_trajectories')"
      );
      expect(order.map((r) => r.table_name)).toEqual([
        "agent_trajectory_steps",
        "agent_trajectories",
      ]);
      // Active: a direct delete of a step is refused (the purge itself refuses an active tenant).
      await expect(
        owner.query("delete from agent_trajectory_steps where tenant_id = $1::uuid", [
          gone.id,
        ])
      ).rejects.toMatchObject({ constraint: "trajectory_step_kept" });
      await owner.query(
        "update tenants set status = 'deleted', purge_after = now() where id = $1::uuid",
        [gone.id]
      );
      await owner.query("select table_name, deleted from public.tenant_purge($1::uuid)", [
        gone.id,
      ]);
      const { rows } = await owner.query(
        `select (select count(*) from agent_trajectory_steps where tenant_id = $1::uuid)::int as steps,
              (select count(*) from agent_trajectories where tenant_id = $1::uuid)::int as runs`,
        [gone.id]
      );
      expect(rows[0]).toEqual({ steps: 0, runs: 0 });
      // Another tenant, still active, keeps the rule.
      const kept = await trajectory(t.id);
      await insertStep(owner, t.id, kept, 0);
      await expect(
        owner.query("delete from agent_trajectory_steps where trajectory_id = $1::uuid", [
          kept,
        ])
      ).rejects.toMatchObject({ constraint: "trajectory_step_kept" });
    });
  }
);
