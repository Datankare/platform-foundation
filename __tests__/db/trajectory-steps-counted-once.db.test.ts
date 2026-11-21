/**
 * @jest-environment node
 */
/**
 * __tests__/db/trajectory-steps-counted-once.db.test.ts — a statement that appends or rewrites a
 * trajectory's steps updates that trajectory once, not once per step, and the erasure's step
 * statement does work in proportion to its steps in any plan (platform TASK-230, ADR-059; 56e-3b R2)
 *
 * What it refuses:
 * - migration 076's bookkeeping done per step row. Round 1's step trigger updated the trajectory's
 *   row (step_count, steps_bytes, version) for every appended or rewritten step, so the erasure's
 *   rewrite of a full (1 000-step) segment wrote 1 000 versions of one row — about 5x the erasure's
 *   cost, enough under load to push a shared session's erasure past the 10 s statement timeout
 *   (hang report §2). 076 now counts a statement's rows in two statement triggers with transition
 *   tables (agent_trajectory_steps_appended, agent_trajectory_steps_rewritten).
 * - work that grows with steps x steps. Without statistics (the transition tables never have any,
 *   and a fresh table has none) the planner may run any join as a nested loop: round 1's erasure
 *   form rejoined the steps it found to the steps it rewrote (1 000 x 1 000 rows for a full
 *   segment, 2.5 s measured), and a join of the old and new transition tables would do the same.
 *   Here every join is forced to be a nested loop and every plan the statement runs — its own and
 *   its triggers', through auto_explain — must handle at most a few rows per step in any one node.
 *
 * Counts, never times: pg_stat_get_xact_tuples_updated(agent_trajectories) read before and after
 * the statement in one transaction of this connection (the rows this backend updated, not
 * database-wide statistics), and the plans' own row counts.
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { stepUpdateLockingTrajectories } from "@/platform/auth/user-data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const STEPS = 1000;

let owner: Client;
let t: TestTenant;

/** A trajectory of `t` (as the owner), its id. */
async function trajectory(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id, scope_type)
     values ($1::uuid, $2::uuid, 't', 'agent', 'counted-once', 'platform')`,
    [id, t.id]
  );
  return id;
}

/** Appends steps `$3` … `$3 + $4 - 1` to trajectory `$2` of tenant `$1`, in ONE statement. */
const APPEND = `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
  select $1::uuid, $2::uuid, i, jsonb_build_object('i', i, 'who', 'someone')
    from generate_series($3::int, $3::int + $4::int - 1) i order by i`;

/** A trajectory of `t` holding `n` steps, its id. */
async function run(n: number): Promise<string> {
  const id = await trajectory();
  await owner.query(APPEND, [t.id, id, 0, n]);
  return id;
}

/** The trajectories' counters and version, and the rows' own count and printed bytes, by id. */
async function state(ids: string[]) {
  const { rows } = await owner.query(
    `select t.id, t.step_count, t.steps_bytes::bigint as steps_bytes, t.version,
            (select count(*)::int from agent_trajectory_steps s where s.trajectory_id = t.id) as rows,
            (select coalesce(sum(octet_length(s.step::text)), 0)::bigint from agent_trajectory_steps s
              where s.trajectory_id = t.id) as printed
       from agent_trajectories t where t.id = any($1::uuid[]) order by t.id`,
    [ids]
  );
  return rows.map((r) => ({
    id: r.id as string,
    stepCount: Number(r.step_count),
    stepsBytes: Number(r.steps_bytes),
    version: Number(r.version),
    rows: Number(r.rows),
    printed: Number(r.printed),
  }));
}

/** Rows of agent_trajectories this transaction updated so far (this backend's own count). */
async function updatedSoFar(): Promise<number> {
  const { rows } = await owner.query(
    "select pg_stat_get_xact_tuples_updated('public.agent_trajectories'::regclass)::int as n"
  );
  return rows[0].n as number;
}

/** `sql` (with `values`) in a transaction of its own: how many trajectory rows it updated. */
async function trajectoryUpdatesOf(sql: string, values: unknown[]): Promise<number> {
  await owner.query("begin");
  try {
    const before = await updatedSoFar();
    await owner.query(sql, values);
    const after = await updatedSoFar();
    await owner.query("commit");
    return after - before;
  } catch (e) {
    await owner.query("rollback");
    throw e;
  }
}

interface PlanNode {
  "Node Type": string;
  "Parent Relationship"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Join Filter"?: number;
  Plans?: PlanNode[];
}

/**
 * The most rows one node of `plan` handled — returned, filtered out or rejected by a join, every
 * loop counted (EXPLAIN gives these per loop).
 */
function mostRowsOneNode(plan: PlanNode): { rows: number; node: string } {
  const loops = plan["Actual Loops"] ?? 1;
  const here =
    ((plan["Actual Rows"] ?? 0) +
      (plan["Rows Removed by Filter"] ?? 0) +
      (plan["Rows Removed by Join Filter"] ?? 0)) *
    loops;
  let best = { rows: here, node: plan["Node Type"] };
  for (const child of plan.Plans ?? []) {
    const c = mostRowsOneNode(child);
    if (c.rows > best.rows) best = c;
  }
  return best;
}

/**
 * The nodes between `plan`'s ModifyTable and the rows it modifies — its main input, through every
 * node on that path (not the CTEs and init plans it reads first): their types.
 */
function updatePath(plan: PlanNode): string[] {
  if (plan["Node Type"] === "ModifyTable") {
    const input = (plan.Plans ?? []).filter(
      (c) => (c["Parent Relationship"] ?? "") === "Outer"
    );
    return input.flatMap((c) => mainPath(c));
  }
  return (plan.Plans ?? []).flatMap((c) => updatePath(c));
}
function mainPath(plan: PlanNode): string[] {
  const below = (plan.Plans ?? []).filter((c) =>
    ["Outer", "Inner", "Member"].includes(c["Parent Relationship"] ?? "")
  );
  return [plan["Node Type"], ...below.flatMap((c) => mainPath(c))];
}

/**
 * `sql` run in a transaction rolled back, on statistics taken in it (D-15), every join forced to a
 * nested loop (hash and merge joins off: the worst a plan with no statistics can pick, and the
 * only plan for a join of the transition tables, which never have any), every plan it runs — nested ones, its
 * triggers', included — read through auto_explain: the most rows one node handled, where, and how
 * many plans were read. auto_explain is PostgreSQL's own module; LOAD needs the owner's
 * superuser connection, as the test database's owner is.
 */
async function worstNode(sql: string, values: unknown[]) {
  const plans: { "Query Text": string; Plan: PlanNode }[] = [];
  const onNotice = (n: { message?: string }) => {
    const m = /plan:\s*(\{[\s\S]*\})\s*$/.exec(n.message ?? "");
    if (m) plans.push(JSON.parse(m[1]) as { "Query Text": string; Plan: PlanNode });
  };
  owner.on("notice", onNotice);
  await owner.query("begin");
  try {
    // Statistics the same every run (D-15): a sample larger than the tables, taken here.
    await owner.query("set local default_statistics_target = 10000");
    await owner.query("analyze agent_trajectory_steps");
    await owner.query("analyze agent_trajectories");
    await owner.query("load 'auto_explain'");
    for (const set of [
      "auto_explain.log_min_duration = 0",
      "auto_explain.log_analyze = on",
      "auto_explain.log_nested_statements = on",
      "auto_explain.log_format = json",
      "auto_explain.log_level = notice",
      "client_min_messages = notice",
      "enable_hashjoin = off",
      "enable_mergejoin = off",
    ])
      await owner.query(`set local ${set}`);
    await owner.query(sql, values);
  } finally {
    await owner.query("rollback");
    owner.off("notice", onNotice);
  }
  let worst = { rows: 0, node: "", query: "" };
  for (const p of plans) {
    const w = mostRowsOneNode(p.Plan);
    if (w.rows > worst.rows) worst = { ...w, query: p["Query Text"].slice(0, 120) };
  }
  return { ...worst, plans: plans.length, all: plans };
}

dbDescribe("R2: a statement's steps update each trajectory once (TASK-230)", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
    t = await createTestTenant();
  });

  afterAll(async () => {
    await owner.end();
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  it(`the erasure's rewrite of a full segment (${STEPS} steps) is 1 update of its trajectory, not ${STEPS}`, async () => {
    const id = await run(STEPS);
    const [before] = await state([id]);
    // The erasure's own statement form (lock the trajectories first, then rewrite the steps).
    const n = await trajectoryUpdatesOf(
      stepUpdateLockingTrajectories(
        "s.trajectory_id = $1::uuid",
        `jsonb_set(s.step, '{who}', '"erased-longer"'::jsonb)`
      ),
      [id]
    );
    expect(n).toBe(1);
    const [after] = await state([id]);
    expect(after.version).toBe(before.version + 1);
    expect(after.stepCount).toBe(STEPS);
    expect([after.stepCount, after.stepsBytes]).toEqual([after.rows, after.printed]);
    // Each step's text grew by the longer value's extra characters, counted once in the total.
    expect(after.stepsBytes).toBe(
      before.stepsBytes + STEPS * ("erased-longer".length - "someone".length)
    );
  });

  it("one statement over two trajectories updates each once; a statement that changes no step updates none", async () => {
    const a = await run(40);
    const b = await run(7);
    const before = await state([a, b]);
    const n = await trajectoryUpdatesOf(
      stepUpdateLockingTrajectories(
        "s.trajectory_id = any($1::uuid[])",
        `jsonb_set(s.step, '{who}', '"x"'::jsonb)`
      ),
      [[a, b]]
    );
    expect(n).toBe(2);
    const after = await state([a, b]);
    for (const [i, s] of after.entries()) {
      expect(s.version).toBe(before[i].version + 1);
      expect([s.stepCount, s.stepsBytes]).toEqual([s.rows, s.printed]);
    }
    // Every step written with what it already holds: nothing rewritten, nothing counted.
    const none = await trajectoryUpdatesOf(
      "update agent_trajectory_steps s set step = s.step where s.trajectory_id = any($1::uuid[])",
      [[a, b]]
    );
    expect(none).toBe(0);
    expect(await state([a, b])).toEqual(after);
  });

  it(`an append of ${STEPS - 1} steps in one statement is 1 update of its trajectory; one step is 1 too`, async () => {
    const id = await trajectory();
    const [before] = await state([id]);
    expect(await trajectoryUpdatesOf(APPEND, [t.id, id, 0, STEPS - 1])).toBe(1);
    expect(await trajectoryUpdatesOf(APPEND, [t.id, id, STEPS - 1, 1])).toBe(1);
    const [after] = await state([id]);
    expect(after.stepCount).toBe(STEPS);
    expect(after.version).toBe(before.version + 2);
    expect([after.stepCount, after.stepsBytes]).toEqual([after.rows, after.printed]);
  });

  it("several rows in one statement are appends in their order: a gap, a repeat or a reversal among them is refused (trajectory_step_order), nothing written", async () => {
    const id = await run(2);
    const [before] = await state([id]);
    const rows = (seqs: number[]) =>
      owner.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
         select $1::uuid, $2::uuid, x.seq, jsonb_build_object('i', x.seq)
           from unnest($3::int[]) with ordinality x(seq, n) order by x.n`,
        [t.id, id, seqs]
      );
    for (const seqs of [
      [2, 4],
      [2, 3, 3],
      [3, 2],
      [1, 2],
    ])
      await expect(rows(seqs)).rejects.toMatchObject({
        code: "23514",
        constraint: "trajectory_step_order",
      });
    expect(await state([id])).toEqual([before]);
    await rows([2, 3, 4]);
    const [after] = await state([id]);
    expect(after.stepCount).toBe(5);
    expect([after.stepCount, after.stepsBytes]).toEqual([after.rows, after.printed]);
  });

  it("a statement appending to two trajectories updates each once, and each counts its own rows", async () => {
    const a = await trajectory();
    const b = await trajectory();
    const n = await trajectoryUpdatesOf(
      `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       select $1::uuid, x.id, i, jsonb_build_object('i', i)
         from (values ($2::uuid, 30), ($3::uuid, 5)) x(id, n), generate_series(0, x.n - 1) i
        order by x.id, i`,
      [t.id, a, b]
    );
    expect(n).toBe(2);
    const counted = new Map((await state([a, b])).map((s) => [s.id, s]));
    for (const [id, k] of [
      [a, 30],
      [b, 5],
    ] as const) {
      const s = counted.get(id);
      expect([s?.stepCount, s?.rows, s?.stepsBytes]).toEqual([k, k, s?.printed]);
    }
  });

  it("an append reads no other step: a step stored out of line costs the same toast reads on an empty and on a full-of-large-steps segment", async () => {
    // ~290 KB that does not compress (md5 chained): stored out of line.
    const BIG = `jsonb_build_object('text', (select string_agg(md5(j::text || ':' || $3::text), '') from generate_series(1, 9000) j))`;
    const appendBig = (id: string, seq: number) =>
      owner.query(
        `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step) select $1::uuid, $2::uuid, $3::int, ${BIG}`,
        [t.id, id, seq]
      );
    const toastReadsOf = async (fn: () => Promise<unknown>) => {
      await owner.query("begin");
      try {
        const blocks = async () =>
          Number(
            (
              await owner.query<{ n: string }>(
                `select pg_stat_get_xact_blocks_fetched(c.reltoastrelid)::text as n
                   from pg_class c where c.oid = 'public.agent_trajectory_steps'::regclass`
              )
            ).rows[0].n
          );
        const before = await blocks();
        await fn();
        const read = (await blocks()) - before;
        await owner.query("commit");
        return read;
      } catch (e) {
        await owner.query("rollback");
        throw e;
      }
    };
    const empty = await trajectory();
    const full = await trajectory();
    for (let i = 0; i < 20; i++) await appendBig(full, i);
    const onEmpty = await toastReadsOf(() => appendBig(empty, 0));
    const onFull = await toastReadsOf(() => appendBig(full, 20));
    // The 20 large steps already there (≈ 5.8 MB) are not read: the same reads either way —
    // the new step's own, measured once by the statement trigger.
    expect(onFull).toBe(onEmpty);
    for (const s of await state([empty, full]))
      expect([s.stepCount, s.stepsBytes]).toEqual([s.rows, s.printed]);
  });

  const N = 400;

  /** Every step row stored (a scan of the table may read them all: linear, whatever the plan). */
  const stored = async () =>
    Number(
      (await owner.query("select count(*)::int as n from agent_trajectory_steps")).rows[0]
        .n
    );

  it(`the erasure's step statement on ${N} steps reads the steps it rewrites with no join; no plan of its triggers handles steps x steps`, async () => {
    const id = await run(N);
    const sql = stepUpdateLockingTrajectories(
      "s.trajectory_id = $1::uuid and s.step->>'who' = 'someone'",
      `jsonb_set(s.step, '{who}', '"erased"'::jsonb)`
    );
    const w = await worstNode(sql, [id]);
    // Every plan was read: the statement's, and its triggers' (the row trigger's, per step).
    expect(w.plans).toBeGreaterThan(N);
    // The update's input is a scan of the steps, joined to nothing: round 1's form rejoined the
    // steps it found (a join the planner may run as a nested loop over both: steps x steps).
    const top = w.all.find((p) => p["Query Text"] === sql);
    expect(top).toBeDefined();
    const path = updatePath(top?.Plan as PlanNode);
    expect(path.some((n) => /Scan$/.test(n))).toBe(true);
    expect(path.filter((n) => /Join|Nested Loop/.test(n))).toEqual([]);
    // The triggers' plans (the statement's own counting among them): linear, at most a few times
    // the rows there are — steps x steps would be N * N = 160 000.
    const bound = 3 * ((await stored()) + N);
    expect(N * N).toBeGreaterThan(bound);
    expect({ ...w, all: undefined, linear: w.rows <= bound }).toMatchObject({
      linear: true,
    });
  });

  it(`an append of ${N} steps in one statement: no plan node handles steps x steps, even with every join a nested loop`, async () => {
    const id = await trajectory();
    const w = await worstNode(APPEND, [t.id, id, 0, N]);
    expect(w.plans).toBeGreaterThan(N);
    const bound = 3 * ((await stored()) + N);
    expect(N * N).toBeGreaterThan(bound);
    expect({ ...w, all: undefined, linear: w.rows <= bound }).toMatchObject({
      linear: true,
    });
  });
});
