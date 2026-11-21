/**
 * @jest-environment node
 */
/**
 * __tests__/db/trajectory-retention-bound.db.test.ts — every delete that takes trajectories takes
 * their steps with them, so it is bounded by the steps too and says when it left due rows; the
 * reaper's closing step goes only where it fits (platform TASK-230, ADR-059; design 56e-3b §2.4,
 * T5; confirmation CB3-3, CB3-4)
 *
 * What it refuses: a retention delete whose cascade is unbounded in steps; a bounded delete that says
 * "nothing more" when its step bound left due trajectories (the job would stop with a backlog); a
 * reaper whose closing step into a full run fails the whole batch, every tick
 *
 * The bound's logic is driven with a small bound and real rows (the rows deleted are counted); the
 * platform's constant (TRAJECTORY_RETENTION_STEPS, 50 000) with the counters the bound reads,
 * set as only a hand-made row could (session_replication_role = replica skips the chain guard that
 * keeps them; the step trigger is not involved).
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import {
  TRAJECTORY_MAX_STEPS,
  TRAJECTORY_RETENTION_STEPS,
} from "@/platform/errors/json-limits";
import { applyRetention, deleteOrphanedSessionRuns } from "@/platform/jobs/retention";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
  type TestTenant,
} from "../helpers/db";

let owner: Client;

/** A run of `tenant`: its status, last update and `steps` real step rows. */
async function run(
  tenant: string,
  opts: {
    status?: string;
    age?: string;
    steps?: number;
    kind?: string;
    subject?: string;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type, status, created_at, updated_at)
     values ($1::uuid, $2::uuid, 'rb', $3, $4, 'platform', $5::trajectory_status,
             now() - $6::interval, now() - $6::interval)`,
    [
      id,
      tenant,
      opts.kind ?? "agent",
      opts.subject ?? "rb",
      opts.status ?? "completed",
      opts.age ?? "400 days",
    ]
  );
  if (opts.steps)
    await owner.query(
      `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       select $1::uuid, $2::uuid, i, jsonb_build_object('i', i) from generate_series(0, $3::int - 1) i order by i`,
      [tenant, id, opts.steps]
    );
  // (The step trigger moves version and the counters, never updated_at: the run keeps its age.)
  return id;
}

/** Set a run's step counter as only a hand-made row could (the chain guard skipped). */
async function counted(id: string, steps: number): Promise<void> {
  await owner.query("begin");
  await owner.query("set local session_replication_role = replica");
  await owner.query("update agent_trajectories set step_count = $2 where id = $1::uuid", [
    id,
    steps,
  ]);
  await owner.query("commit");
}

const exists = async (ids: string[]) =>
  (
    await owner.query(
      "select id::text as id from agent_trajectories where id = any($1::uuid[])",
      [ids]
    )
  ).rows.map((r) => r.id as string);

const stepRows = async (tenant: string) =>
  (
    await owner.query(
      "select count(*)::int as n from agent_trajectory_steps where tenant_id = $1::uuid",
      [tenant]
    )
  ).rows[0].n as number;

dbDescribe(
  "T5: retention bounded by the steps it deletes; the reaper's step only where it fits",
  () => {
    beforeAll(async () => {
      await connectTestDatabase();
      owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
      await owner.connect();
    });

    afterAll(async () => {
      await owner.end();
      await dropTestTenants();
      await disconnectTestDatabase();
    });

    describe("(CB3-4) deleteFinishedBefore", () => {
      let t: TestTenant;
      beforeEach(async () => {
        t = await createTestTenant();
      });

      it("oldest first while the steps fit — the first always — counted rows deleted; more while a due run is left", async () => {
        const store = inTenant(new PostgresTrajectoryStore(), t);
        const a = await run(t.id, { age: "403 days", steps: 30 });
        const b = await run(t.id, { age: "402 days", steps: 30 });
        const c = await run(t.id, { age: "401 days", steps: 30 });
        const fresh = await run(t.id, { age: "1 day", steps: 5 });
        const cutoff = new Date(Date.now() - 10 * 24 * 3600_000);
        expect(await stepRows(t.id)).toBe(95);
        // A bound of 50 steps: the first run (30) goes; the second would make 60.
        expect(await store.deleteFinishedBefore(cutoff, 100, 50)).toEqual({
          deleted: 1,
          more: true,
        });
        expect(await stepRows(t.id)).toBe(65);
        expect((await exists([a, b, c])).sort()).toEqual([b, c].sort());
        // A bound under one run's steps: one run all the same, never none.
        expect(await store.deleteFinishedBefore(cutoff, 100, 1)).toEqual({
          deleted: 1,
          more: true,
        });
        expect(await store.deleteFinishedBefore(cutoff, 100, 50)).toEqual({
          deleted: 1,
          more: false,
        });
        expect(await exists([a, b, c, fresh])).toEqual([fresh]);
        expect(await stepRows(t.id)).toBe(5);
      });

      it("the trajectory bound says more too; nothing due says nothing more", async () => {
        const store = inTenant(new PostgresTrajectoryStore(), t);
        await run(t.id, { age: "402 days" });
        await run(t.id, { age: "401 days" });
        const cutoff = new Date(Date.now() - 10 * 24 * 3600_000);
        expect(await store.deleteFinishedBefore(cutoff, 1)).toEqual({
          deleted: 1,
          more: true,
        });
        expect(await store.deleteFinishedBefore(cutoff, 1)).toEqual({
          deleted: 1,
          more: false,
        });
        expect(await store.deleteFinishedBefore(cutoff, 1)).toEqual({
          deleted: 0,
          more: false,
        });
      });

      it(`the platform's bound: ${TRAJECTORY_RETENTION_STEPS} steps per delete (counted by the runs' step_count)`, async () => {
        const store = inTenant(new PostgresTrajectoryStore(), t);
        const runs = [] as string[];
        for (let i = 0; i < 3; i++) {
          const id = await run(t.id, { age: `${410 - i} days` });
          await counted(id, 20_000);
          runs.push(id);
        }
        const cutoff = new Date(Date.now() - 10 * 24 * 3600_000);
        // 20 000 + 20 000 fit; the third would make 60 000.
        expect(await store.deleteFinishedBefore(cutoff, 5000)).toEqual({
          deleted: 2,
          more: true,
        });
        expect(await exists(runs)).toEqual([runs[2]]);
      });
    });

    describe("(CB3-4) the session deletes of data.retention", () => {
      it("orphaned session runs: bounded by their steps, more while one is left", async () => {
        const t = await createTestTenant();
        const o1 = await run(t.id, {
          kind: "session",
          subject: "gone-1",
          status: "running",
          age: "3 hours",
          steps: 30,
        });
        const o2 = await run(t.id, {
          kind: "session",
          subject: "gone-2",
          status: "running",
          age: "2 hours",
          steps: 30,
        });
        expect(await t.run(() => deleteOrphanedSessionRuns(100, 50))).toEqual({
          deleted: 1,
          more: true,
        });
        expect(await exists([o1, o2])).toEqual([o2]);
        expect(await t.run(() => deleteOrphanedSessionRuns(100, 50))).toEqual({
          deleted: 1,
          more: false,
        });
        expect(await stepRows(t.id)).toBe(0);
      });

      it("idle sessions: their runs' steps bound the batch (the platform's bound), and the rule says more", async () => {
        const t = await createTestTenant();
        const sessions: string[] = [];
        for (let i = 0; i < 3; i++) {
          const sid = `idle-${i}-${t.id}`;
          await owner.query(
            `insert into app_sessions (id, tenant_id, state, created_at, updated_at)
           values ($1, $2::uuid, '{}'::jsonb, now() - $3::interval, now() - $3::interval)`,
            [sid, t.id, `${500 - i} days`]
          );
          const r = await run(t.id, {
            kind: "session",
            subject: sid,
            status: "running",
            age: `${500 - i} days`,
          });
          await counted(r, 30_000);
          sessions.push(sid);
        }
        const r1 = await t.run(() => applyRetention(undefined, 5000));
        expect(r1.changed.app_sessions).toBe(1);
        expect(r1.more).toBe(true);
        const left = await owner.query(
          "select id from app_sessions where tenant_id = $1::uuid order by id",
          [t.id]
        );
        expect(left.rows.map((r) => r.id)).toEqual(sessions.slice(1).sort());
      });
    });

    describe("(CB3-3) the reaper ends every abandoned run; the closing step only where it fits", () => {
      it("a full run is ended without the step; the other gets it, at its next place; the batch never fails", async () => {
        const t = await createTestTenant();
        const store = inTenant(new PostgresTrajectoryStore(), t);
        const full = await run(t.id, {
          status: "running",
          age: "3 days",
          steps: TRAJECTORY_MAX_STEPS,
        });
        const room = await run(t.id, { status: "running", age: "3 days", steps: 2 });
        const r = await store.closeAbandoned!(new Date(Date.now() - 3600_000), 10);
        expect(r).toMatchObject({ closed: 2, indeterminate: 0 });
        const { rows } = await owner.query(
          `select t.id::text as id, t.status::text as status, t.step_count,
                (select s.step->>'action' from agent_trajectory_steps s where s.trajectory_id = t.id order by s.seq desc limit 1) as last,
                (select (s.step->>'stepIndex')::int from agent_trajectory_steps s where s.trajectory_id = t.id order by s.seq desc limit 1) as idx
           from agent_trajectories t where t.id = any($1::uuid[])`,
          [[full, room]]
        );
        const by = Object.fromEntries(rows.map((x) => [x.id, x]));
        expect(by[full]).toMatchObject({
          status: "failed",
          step_count: TRAJECTORY_MAX_STEPS,
          last: null,
        });
        expect(by[room]).toMatchObject({
          status: "failed",
          step_count: 3,
          last: "trajectory-abandoned",
          idx: 2,
        });
      });
    });
  }
);
