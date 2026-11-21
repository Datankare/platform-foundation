/**
 * @jest-environment node
 */
/**
 * __tests__/db/trajectory-steps-concurrency.db.test.ts — two writers of one trajectory's steps, in
 * every order that matters, scripted (platform TASK-230, ADR-059; design 56e-3b §2.2, T2)
 *
 * What it refuses: an append that waited for a continuation and appended to the continued segment (the
 * chain misnumbered — review TA-b-1), two step rewrites of one trajectory that deadlock (review
 * TA-b-3), a rewrite that waits for a trajectory it did not lock first, and counters that drift from
 * the rows under concurrent writers
 *
 * Each interleaving is driven by connections of its own: the first writer holds its transaction
 * open; the second is started and the test polls pg_locks until it is seen waiting on a lock (no
 * sleep decides anything; a bounded number of polls); then the first commits. The reviewers'
 * reproductions (CONFIRM-56e3b b1, b3; design proto final/b1-after.out, b3-lock-order.out) as
 * tests: their authors are acknowledged in ADR-059.
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { ADDRESS_REPLACEMENTS } from "@/platform/auth/gdpr-deletion";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import type { Step } from "@/platform/agents/types";
import { TRAJECTORY_MAX_STEPS } from "@/platform/errors/json-limits";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
  type TestTenant,
} from "../helpers/db";

type Iso = "read committed" | "repeatable read" | "serializable";

let owner: Client;
const opened: Client[] = [];

/** A connection as the owner, or as app_tenant in `tenant`. */
async function connect(as: "owner" | "app", tenant: string): Promise<Client> {
  const c = new Client({
    connectionString:
      as === "owner"
        ? process.env.TEST_DATABASE_OWNER_URL
        : process.env.TEST_DATABASE_URL,
  });
  await c.connect();
  if (as === "app")
    await c.query("select set_config('app.tenant_id', $1, false)", [tenant]);
  opened.push(c);
  return c;
}

/** Poll until backend `pid` waits on a lock (bounded: never a fixed sleep that decides). */
async function untilWaiting(pid: number): Promise<void> {
  for (let i = 0; i < 4000; i++) {
    const { rows } = await owner.query(
      "select count(*)::int as n from pg_locks where pid = $1 and not granted",
      [pid]
    );
    if (rows[0].n > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

const pidOf = async (c: Client): Promise<number> =>
  (await c.query("select pg_backend_pid() as pid")).rows[0].pid as number;

/** What a statement came to: committed, or its error's SQLSTATE and constraint. */
async function outcome(c: Client, run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    await c.query("commit");
    return "committed";
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    const e = err as { code?: string; constraint?: string };
    return `refused ${e.code}${e.constraint ? ` ${e.constraint}` : ""}`;
  }
}

async function trajectory(tenant: string, steps: number): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type)
     values ($1::uuid, $2::uuid, 't', 'agent', 'race', 'platform')`,
    [id, tenant]
  );
  if (steps > 0)
    await owner.query(
      `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       select $1::uuid, $2::uuid, i, jsonb_build_object('k', i) from generate_series(0, $3::int - 1) i order by i`,
      [tenant, id, steps]
    );
  return id;
}

/** The chain's numbering and every segment's counters against its rows. */
async function chainState(root: string) {
  const { rows } = await owner.query(
    `select t.segment, t.step_offset, t.step_count, t.continued,
            (select count(*)::int from agent_trajectory_steps s where s.trajectory_id = t.id) as rows,
            t.steps_bytes::bigint = (select coalesce(sum(octet_length(s.step::text)), 0) from agent_trajectory_steps s
                                      where s.trajectory_id = t.id) as bytes_true,
            (select coalesce(max(seq), -1) + 1 = count(*) from agent_trajectory_steps s where s.trajectory_id = t.id) as no_gap
       from agent_trajectories t where t.chain_root_id = $1::uuid order by t.segment`,
    [root]
  );
  let offset = 0;
  const problems: string[] = [];
  for (const r of rows) {
    if (r.step_offset !== offset)
      problems.push(`segment ${r.segment}: offset ${r.step_offset} ≠ ${offset}`);
    if (r.step_count !== r.rows)
      problems.push(`segment ${r.segment}: step_count ${r.step_count} ≠ rows ${r.rows}`);
    if (!r.bytes_true)
      problems.push(`segment ${r.segment}: steps_bytes ≠ the rows' text`);
    if (!r.no_gap) problems.push(`segment ${r.segment}: a gap in seq`);
    const last = r === rows[rows.length - 1];
    if (r.continued === last)
      problems.push(`segment ${r.segment}: continued ${r.continued}`);
    offset += r.step_count;
  }
  return { segments: rows.length, problems };
}

dbDescribe("T2: concurrent writers of one trajectory's steps (TASK-230)", () => {
  let t: TestTenant;

  beforeAll(async () => {
    await connectTestDatabase();
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
    t = await createTestTenant();
  });

  afterAll(async () => {
    for (const c of opened) await c.end().catch(() => undefined);
    await owner.end();
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  // Review TA-b-1 (CONFIRM b1): the append waits for the continuation's lock on the segment; the
  // continuation marks the segment `continued` in its own statement, and the append reads that from
  // the row it locked — refused (READ COMMITTED) or fails to serialize — never appended.
  const variants: [as: "owner" | "app", iso: Iso, expected: RegExp][] = [
    ["owner", "read committed", /^refused 23514 trajectory_continued$/],
    ["app", "read committed", /^refused 23514 trajectory_continued$/],
    ["owner", "repeatable read", /^refused 40001$/],
    ["app", "repeatable read", /^refused 40001$/],
    ["owner", "serializable", /^refused 40001$/],
    ["app", "serializable", /^refused 40001$/],
  ];
  it.each(variants)(
    "(TA-b-1) an append that waited for a continuation (%s, %s) never appends: the chain stays numbered",
    async (as, iso, expected) => {
      const first = await trajectory(t.id, 2);
      const s1 = await connect(as, t.id);
      const s2 = await connect(as, t.id);
      await s1.query("begin");
      await s1.query(
        `insert into agent_trajectories (tenant_id, trigger, subject_kind, subject_id, scope_type, segment, previous_trajectory_id, step_offset)
         values ($1::uuid, 't', 'agent', 'race', 'platform', 2, $2::uuid, 2)`,
        [t.id, first]
      );
      await s2.query(`begin isolation level ${iso}`);
      // The snapshot of repeatable read and serializable is taken by the first statement.
      await s2.query("select 1 from agent_trajectories where id = $1::uuid", [first]);
      const pid = await pidOf(s2);
      const appended = outcome(s2, () =>
        s2.query(
          `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
           values ($1::uuid, $2::uuid, 2, '{"k": "late"}')`,
          [t.id, first]
        )
      );
      await untilWaiting(pid);
      await s1.query("commit");
      expect(await appended).toMatch(expected);
      expect(await chainState(first)).toEqual({ segments: 2, problems: [] });
    }
  );

  it("(TA-b-1, reverse) the append first: the continuation waits, a stale offset is refused, the right one goes in", async () => {
    const first = await trajectory(t.id, 2);
    const s1 = await connect("app", t.id);
    const s2 = await connect("app", t.id);
    await s1.query("begin");
    await s1.query(
      `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step) values ($1::uuid, $2::uuid, 2, '{"k": 2}')`,
      [t.id, first]
    );
    await s2.query("begin");
    const pid = await pidOf(s2);
    const continued = outcome(s2, () =>
      s2.query(
        `insert into agent_trajectories (tenant_id, trigger, subject_kind, subject_id, scope_type, segment, previous_trajectory_id, step_offset)
         values ($1::uuid, 't', 'agent', 'race', 'platform', 2, $2::uuid, 2)`,
        [t.id, first]
      )
    );
    await untilWaiting(pid);
    await s1.query("commit");
    expect(await continued).toBe("refused 23514");
    await owner.query(
      `insert into agent_trajectories (tenant_id, trigger, subject_kind, subject_id, scope_type, segment, previous_trajectory_id, step_offset)
       values ($1::uuid, 't', 'agent', 'race', 'platform', 2, $2::uuid, 3)`,
      [t.id, first]
    );
    expect(await chainState(first)).toEqual({ segments: 2, problems: [] });
  });

  it("two appends at one place serialise on the trajectory: the second, after the first, is out of order", async () => {
    const id = await trajectory(t.id, 0);
    const s1 = await connect("app", t.id);
    const s2 = await connect("app", t.id);
    await s1.query("begin");
    await s1.query(
      `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step) values ($1::uuid, $2::uuid, 0, '{"k": 1}')`,
      [t.id, id]
    );
    await s2.query("begin");
    const pid = await pidOf(s2);
    const second = outcome(s2, () =>
      s2.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step) values ($1::uuid, $2::uuid, 0, '{"k": 2}')`,
        [t.id, id]
      )
    );
    await untilWaiting(pid);
    await s1.query("commit");
    expect(await second).toBe("refused 23514 trajectory_step_order");
    expect(await chainState(id)).toEqual({ segments: 1, problems: [] });
  });

  // Review TA-b-3 (design b3): the erasure's form locks every trajectory it will rewrite first, in
  // key order; the step trigger never waits for a trajectory. So two erasures of one trajectory
  // serialise at the trajectory — the second waits, then both commit; no 40P01.
  it("(TA-b-3) two erasures of one trajectory, each in the locking form: the second waits, both commit", async () => {
    const id = await trajectory(t.id, 0);
    await owner.query(
      `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       values ($1::uuid, $2::uuid, 0, '{"to": "ann@race.test"}'), ($1::uuid, $2::uuid, 1, '{"cc": "bob@race.test"}')`,
      [t.id, id]
    );
    const s1 = await connect("app", t.id);
    const s2 = await connect("app", t.id);
    const STEPS = ADDRESS_REPLACEMENTS.find((s) => s.includes("agent_trajectory_steps"))!;
    await s1.query("begin");
    await s1.query(STEPS, ["ann@race.test", "11111111-1111-4111-8111-111111111111"]);
    await s2.query("begin");
    const pid = await pidOf(s2);
    const second = outcome(s2, () =>
      s2.query(STEPS, ["bob@race.test", "22222222-2222-4222-8222-222222222222"])
    );
    await untilWaiting(pid);
    await s1.query("commit");
    expect(await second).toBe("committed");
    const { rows } = await owner.query(
      "select step from agent_trajectory_steps where trajectory_id = $1::uuid order by seq",
      [id]
    );
    expect(rows.map((r) => r.step)).toEqual([
      { to: "11111111-1111-4111-8111-111111111111" },
      { cc: "22222222-2222-4222-8222-222222222222" },
    ]);
    expect(await chainState(id)).toEqual({ segments: 1, problems: [] });
  });

  it("(TA-b-3) a rewrite that did not lock its trajectory first is refused at once (55P03), never waits", async () => {
    const id = await trajectory(t.id, 1);
    const s1 = await connect("app", t.id);
    const s2 = await connect("app", t.id);
    await s1.query("begin");
    await s1.query("select 1 from agent_trajectories where id = $1::uuid for update", [
      id,
    ]);
    await s2.query("begin");
    const pid = await pidOf(s2);
    let waited = false;
    const direct = outcome(s2, () =>
      s2.query(
        `update agent_trajectory_steps set step = '{"k": "direct"}' where trajectory_id = $1::uuid`,
        [id]
      )
    );
    // Either it has already been refused, or it waits — which is the fault: then release it.
    const settled = await Promise.race([
      direct,
      (async () => {
        try {
          await untilWaiting(pid);
          waited = true;
        } catch {
          // never waited
        }
        return "polled";
      })(),
    ]);
    await s1.query("commit");
    const result = settled === "polled" ? await direct : settled;
    expect(waited).toBe(false);
    expect(result).toBe("refused 55P03");
  });

  it("an erasure and retention's delete of one trajectory: one waits for the other, neither fails", async () => {
    const id = await trajectory(t.id, 0);
    await owner.query(
      `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       values ($1::uuid, $2::uuid, 0, '{"to": "cy@race.test"}')`,
      [t.id, id]
    );
    await owner.query(
      "update agent_trajectories set status = 'completed', updated_at = now() - interval '400 days' where id = $1::uuid",
      [id]
    );
    const s1 = await connect("app", t.id);
    const s2 = await connect("app", t.id);
    const STEPS = ADDRESS_REPLACEMENTS.find((s) => s.includes("agent_trajectory_steps"))!;
    await s1.query("begin");
    await s1.query(STEPS, ["cy@race.test", "33333333-3333-4333-8333-333333333333"]);
    await s2.query("begin");
    const pid = await pidOf(s2);
    const deleted = outcome(s2, () =>
      s2.query("delete from agent_trajectories where id = $1::uuid", [id])
    );
    await untilWaiting(pid);
    await s1.query("commit");
    expect(await deleted).toBe("committed");
    const { rows } = await owner.query(
      "select count(*)::int as n from agent_trajectory_steps where trajectory_id = $1::uuid",
      [id]
    );
    expect(rows[0].n).toBe(0);
  });

  it("appenders through the store with rollover and blind writers at once: the chain stays whole", async () => {
    const store = inTenant(new PostgresTrajectoryStore(), t);
    const root = (await store.create({ kind: "agent", id: "many" }, "t", "platform"))
      .trajectory.trajectoryId;
    await owner.query(
      `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       select $1::uuid, $2::uuid, i, jsonb_build_object('k', i) from generate_series(0, $3::int - 6) i order by i`,
      [t.id, root, TRAJECTORY_MAX_STEPS]
    );
    const step = (i: number): Step => ({
      stepIndex: i,
      action: `a${i}`,
      input: {},
      output: {},
      cost: 0,
      durationMs: 0,
      timestamp: new Date(0).toISOString(),
      boundary: "cognition",
    });
    const blind = await connect("app", t.id);
    const blindWrites = async () => {
      const out: string[] = [];
      for (let i = 0; i < 20; i++) {
        // A writer that takes no lock and guesses a place: every guess not the next is refused.
        try {
          await blind.query(
            `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
             values ($1::uuid, $2::uuid, $3::int, '{"blind": true}')`,
            [t.id, root, TRAJECTORY_MAX_STEPS - 3 + (i % 4)]
          );
          out.push("in");
        } catch (err) {
          out.push((err as { constraint?: string }).constraint ?? "?");
        }
      }
      return out;
    };
    const [appended, blindOut] = await Promise.all([
      Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          store.addStep(root, step(i), { rollover: true })
        )
      ),
      blindWrites(),
    ]);
    expect(appended).toHaveLength(30);
    expect(blindOut.length).toBeGreaterThan(0);
    expect(appended.every(Boolean)).toBe(true);
    expect(
      blindOut.every((o) =>
        [
          "in",
          "trajectory_step_order",
          "trajectory_full",
          "trajectory_continued",
        ].includes(o)
      )
    ).toBe(true);
    const state = await chainState(root);
    expect(state.problems).toEqual([]);
    expect(state.segments).toBe(2);
    // Every store append is somewhere in the chain, once.
    const { rows } = await owner.query(
      `select count(distinct s.step->>'action')::int as n from agent_trajectory_steps s
         join agent_trajectories a on a.id = s.trajectory_id
        where a.chain_root_id = $1::uuid and s.step ? 'action'`,
      [root]
    );
    expect(rows[0].n).toBe(30);
  });
});
