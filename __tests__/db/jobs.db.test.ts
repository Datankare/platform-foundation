/**
 * @jest-environment node
 */
/**
 * __tests__/db/jobs.db.test.ts — the job queue on the replayed Postgres (ADR-056 D2, D3)
 *
 * The JobStore kit against PostgresJobStore, then what only a real database can show:
 *   - two workers ticking at once never run the same job (FOR UPDATE SKIP LOCKED);
 *   - a worker that dies leaves a job another worker recovers when its lease lapses, and the
 *     dead worker's late settle changes nothing;
 *   - a job that fails on every attempt is dead-lettered with sanitized wording, replayed once;
 *   - a job runs inside its tenant under row-level security: it sees only its tenant's rows and
 *     cannot write another's;
 *   - the claim is closed to every role but the owner (TASK-137), and app_tenant can neither
 *     change jobs nor read schedules;
 *   - the same idempotency key in two tenants is two jobs; repeated, the same one;
 *   - a schedule slot reaches every active tenant, never a suspended one;
 *   - the core duties do their work, each in its tenant: the GDPR retention purge, lapsed
 *     restrictions, trajectory retention, stale approvals.
 *
 * And what the R4–R6 review proved and the fixes hold (each test names its finding):
 *   - the request role inserts no job at all (4);
 *   - 300 000 due jobs a claim cannot take — a suspended tenant's, parked — and 300 000 of one
 *     busy tenant leave a claim fast and fair: another tenant's one job is in the first batch
 *     (5, 6; the claim took 423 ms at 300 000 parked-able rows before);
 *   - the GDPR purge runs for a suspended tenant, and nothing else does (7);
 *   - one tenant's success never overwrites another's failure on the schedule (8);
 *   - re-applying 050 keeps a dual-control key an operator removed removed (9) — proved by the
 *     migration replay, not here (see the note at the end of the hostile cases).
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { runJobStoreContract } from "../contract/job-store-contract";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  enqueueJob,
  PostgresJobStore,
  registerJob,
  resetJobRegistry,
  resetJobStore,
  runDue,
  setJobStore,
  type JobContext,
} from "@/platform/jobs";
import {
  setTrajectoryStore,
  type TrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";

let a: TestTenant;
let b: TestTenant;
const store = new PostgresJobStore();
const RUN = randomUUID().slice(0, 8);
const K = (name: string) => `dbtest.${name}${RUN}`;

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("operator", (tx) => tx.query<R>(sql, values));

/** A plan node as auto_explain's JSON prints it (the fields read here). */
interface PlanNode {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

/**
 * How many rows of jobs one job_claim call reads — returned plus filtered out, over every
 * statement inside it — measured from the executed plans (auto_explain, rolled back so nothing
 * is claimed). A count of work, not a duration: the same on a loaded CI machine as on an idle
 * one, so the bound cannot be missed by a slow run or met by a fast one.
 */
async function rowsOfJobsAClaimReads(kinds: string[], limit: number): Promise<number> {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
  const plans: PlanNode[] = [];
  client.on("notice", (n) => {
    const at = n.message?.indexOf("{") ?? -1;
    if (at < 0) return;
    const parsed = JSON.parse(n.message!.slice(at)) as { Plan?: PlanNode };
    if (parsed.Plan) plans.push(parsed.Plan);
  });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("load 'auto_explain'");
    for (const [k, v] of [
      ["auto_explain.log_min_duration", "0"],
      ["auto_explain.log_analyze", "on"],
      ["auto_explain.log_nested_statements", "on"],
      ["auto_explain.log_format", "json"],
      ["auto_explain.log_level", "notice"],
    ]) {
      await client.query("select set_config($1, $2, true)", [k, v]);
    }
    await client.query("select 1 from public.job_claim('dbtest-plan', $1, $2, 60)", [
      kinds,
      limit,
    ]);
    await client.query("rollback");
  } finally {
    await client.end();
  }
  const read = (node: PlanNode): number =>
    (node["Relation Name"] === "jobs"
      ? ((node["Actual Rows"] ?? 0) +
          (node["Rows Removed by Filter"] ?? 0) +
          (node["Rows Removed by Index Recheck"] ?? 0)) *
        (node["Actual Loops"] ?? 1)
      : 0) + (node.Plans ?? []).reduce((sum, child) => sum + read(child), 0);
  // The function's own statements are logged as nested plans; the outer select is one more.
  expect(plans.length).toBeGreaterThan(1);
  return plans.reduce((sum, plan) => sum + read(plan), 0);
}

dbDescribe("PostgresJobStore", () => {
  let previousTrajectories: TrajectoryStore;

  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    setJobStore(store);
    previousTrajectories = setTrajectoryStore(new PostgresTrajectoryStore());
  });

  afterAll(async () => {
    await owner("delete from jobs where kind like 'kit.%' or kind like 'dbtest.%'");
    await owner(
      "delete from job_schedules where kind like 'kit.%' or kind like 'dbtest.%'"
    );
    await owner(
      "delete from config_pending_approvals where change_comment like 'dbtest %'"
    );
    await dropTestTenants();
    setTrajectoryStore(previousTrajectories);
    resetJobStore();
    await disconnectTestDatabase();
  });

  afterEach(() => resetJobRegistry());

  describe("conformance", () => {
    runJobStoreContract({
      makeStore: () => store,
      tenants: () => ({
        a: { id: a.id, run: (fn) => a.run(fn) },
        b: { id: b.id, run: (fn) => b.run(fn) },
      }),
    });
  });

  it("two workers ticking at once never run the same job", async () => {
    const kind = K("pair");
    const runs = new Map<string, number>();
    registerJob(
      kind,
      async (ctx) => {
        runs.set(ctx.jobId, (runs.get(ctx.jobId) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 20));
      },
      { description: "Counts its runs.", timeoutMs: 5_000 }
    );
    for (let i = 0; i < 20; i++) {
      await store.enqueue({
        tenantId: i % 2 ? a.id : b.id,
        kind,
        idempotencyKey: `p${i}`,
        maxAttempts: 1,
        source: "enqueue",
      });
    }
    const [x, y] = await Promise.all([
      runDue({ budgetMs: 30_000, kinds: [kind], schedule: false, workerId: "worker-x" }),
      runDue({ budgetMs: 30_000, kinds: [kind], schedule: false, workerId: "worker-y" }),
    ]);
    expect(x.succeeded + y.succeeded).toBe(20);
    expect(runs.size).toBe(20);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  });

  it("recovers a dead worker's job when its lease lapses; the late settle changes nothing", async () => {
    const kind = K("lease");
    registerJob(kind, async () => undefined, {
      description: "Finishes.",
      timeoutMs: 2_000,
    });
    const { id } = await store.enqueue({
      tenantId: a.id,
      kind,
      idempotencyKey: "l",
      maxAttempts: 3,
      source: "enqueue",
    });
    const [held] = await store.claim({
      workerId: "dies",
      kinds: [kind],
      limit: 1,
      leaseMs: 60_000,
    });
    expect(
      (await runDue({ budgetMs: 10_000, kinds: [kind], schedule: false })).claimed
    ).toBe(0);
    await owner(
      "update jobs set locked_until = now() - interval '1 second' where id = $1",
      [id]
    );
    const r = await runDue({ budgetMs: 10_000, kinds: [kind], schedule: false });
    expect(r).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await store.getJob(id)).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(await store.complete(held)).toBe(false);
    expect(await store.bury(held, "late")).toBe(false);
  });

  it("dead-letters after the last attempt with the platform's wording, then replays once", async () => {
    const kind = K("dead");
    registerJob(
      kind,
      async () => {
        throw Object.assign(
          new Error('relation "users" violates constraint users_pkey'),
          {
            code: "23505",
          }
        );
      },
      { description: "Always fails.", maxAttempts: 2, timeoutMs: 2_000 }
    );
    const { id } = await store.enqueue({
      tenantId: a.id,
      kind,
      idempotencyKey: "d",
      maxAttempts: 2,
      source: "enqueue",
    });
    expect(
      (await runDue({ budgetMs: 10_000, kinds: [kind], schedule: false })).retried
    ).toBe(1);
    await owner("update jobs set run_at = now() where id = $1", [id]);
    expect(
      (await runDue({ budgetMs: 10_000, kinds: [kind], schedule: false })).dead
    ).toBe(1);
    const dead = await store.getJob(id);
    expect(dead).toMatchObject({ status: "dead", attempts: 2 });
    expect(dead?.lastError).toBe("A database statement failed (SQLSTATE 23505).");
    expect(await store.replay(id)).toBe("replayed");
    expect(await store.replay(id)).toBe("not_dead");
    expect(await store.getJob(id)).toMatchObject({
      status: "queued",
      attempts: 0,
      source: "replay",
    });
  });

  it("runs each job in its tenant: under row-level security it sees and writes only its own", async () => {
    const kind = K("rls");
    const ua = await a.user("rls");
    const ub = await b.user("rls");
    await a.run(() =>
      withTenantTx((tx) =>
        tx.query("insert into user_devices (user_id, device_id) values ($1, 'a-dev')", [
          ua,
        ])
      )
    );
    await b.run(() =>
      withTenantTx((tx) =>
        tx.query("insert into user_devices (user_id, device_id) values ($1, 'b-dev')", [
          ub,
        ])
      )
    );
    const seen: Record<string, unknown> = {};
    registerJob(
      kind,
      async (ctx: JobContext) => {
        seen.devices = (
          await withTenantTx((tx) =>
            tx.query<{ device_id: string }>("select device_id from user_devices")
          )
        ).rows.map((r) => r.device_id);
        seen.other = (
          await withTenantTx((tx) =>
            tx.query("select 1 from user_devices where tenant_id = $1::uuid", [b.id])
          )
        ).rowCount;
        seen.jobsTenants = [
          ...new Set(
            (
              await withTenantTx((tx) =>
                tx.query<{ tenant_id: string }>("select tenant_id from jobs")
              )
            ).rows.map((r) => r.tenant_id)
          ),
        ];
        try {
          await withTenantTx((tx) =>
            tx.query(
              "insert into user_devices (user_id, device_id, tenant_id) values ($1, 'x', $2)",
              [ub, b.id]
            )
          );
          seen.crossWrite = "accepted";
        } catch {
          seen.crossWrite = "refused";
        }
        seen.tenant = ctx.tenantId;
      },
      { description: "Looks around.", maxAttempts: 1, timeoutMs: 5_000 }
    );
    await store.enqueue({
      tenantId: a.id,
      kind,
      idempotencyKey: "r",
      maxAttempts: 1,
      source: "enqueue",
    });
    expect(
      (await runDue({ budgetMs: 10_000, kinds: [kind], schedule: false })).succeeded
    ).toBe(1);
    expect(seen).toEqual({
      devices: ["a-dev"],
      other: 0,
      jobsTenants: [a.id],
      crossWrite: "refused",
      tenant: a.id,
    });
  });

  it("closes the claim to every role but the owner; app_tenant changes no job and reads no schedule", async () => {
    const { rows } = await owner<{ r: string; can: boolean }>(
      `select r, has_function_privilege(r, 'public.job_claim(text,text[],integer,integer)', 'EXECUTE') as can
         from unnest(array['public','anon','authenticated','app_tenant']) r`
    );
    expect(rows.filter((x) => x.can)).toEqual([]);
    await expect(
      a.run(() =>
        withTenantTx((tx) =>
          tx.query("select * from public.job_claim('x', array['a.b'], 1, 60)")
        )
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      a.run(() => withTenantTx((tx) => tx.query("update jobs set run_at = now()")))
    ).rejects.toThrow(/permission denied/);
    await expect(
      a.run(() => withTenantTx((tx) => tx.query("delete from jobs")))
    ).rejects.toThrow(/permission denied/);
    await expect(
      a.run(() => withTenantTx((tx) => tx.query("select * from job_schedules")))
    ).rejects.toThrow(/permission denied/);
    await expect(
      a.run(() =>
        withTenantTx((tx) =>
          tx.query(
            "insert into jobs (kind, idempotency_key, status) values ('a.b', 'k', 'succeeded')"
          )
        )
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("the same key in two tenants is two jobs; repeated in one, the same job (the request path)", async () => {
    const kind = K("key");
    registerJob(kind, async () => undefined, { description: "Idempotent." });
    const inA = await a.run(() => enqueueJob(kind, { idempotencyKey: "same" }));
    const inB = await b.run(() => enqueueJob(kind, { idempotencyKey: "same" }));
    const again = await a.run(() => enqueueJob(kind, { idempotencyKey: "same" }));
    expect(inA.id).not.toBe(inB.id);
    expect(again).toEqual({ id: inA.id, created: false });
    const tenants = (
      await owner<{ tenant_id: string }>(
        "select tenant_id from jobs where kind = $1 order by tenant_id",
        [kind]
      )
    ).rows.map((r) => r.tenant_id);
    expect(tenants.sort()).toEqual([a.id, b.id].sort());
  });

  it("a slot reaches every active tenant and never a suspended one", async () => {
    const kind = K("fan");
    await owner("update tenants set status = 'suspended' where id = $1", [b.id]);
    try {
      const slot = await store.takeScheduleSlot({
        kind,
        scope: "each-tenant",
        intervalMs: 3_600_000,
        maxAttempts: 1,
        now: new Date(),
      });
      expect(slot!.enqueued).toBeGreaterThanOrEqual(1);
      const tenants = (
        await owner<{ tenant_id: string }>("select tenant_id from jobs where kind = $1", [
          kind,
        ])
      ).rows.map((r) => r.tenant_id);
      expect(tenants).toContain(a.id);
      expect(tenants).not.toContain(b.id);
      expect(
        await store.takeScheduleSlot({
          kind,
          scope: "each-tenant",
          intervalMs: 3_600_000,
          maxAttempts: 1,
          now: new Date(),
        })
      ).toBeNull();
    } finally {
      await owner("update tenants set status = 'active' where id = $1", [b.id]);
      await owner("delete from jobs where kind = $1", [kind]);
    }
  });
});

dbDescribe("the core duties, run as jobs", () => {
  let previousTrajectories: TrajectoryStore;

  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    setJobStore(store);
    previousTrajectories = setTrajectoryStore(new PostgresTrajectoryStore());
  });

  afterAll(async () => {
    await owner("delete from jobs where kind like 'dbtest.%'");
    await owner(
      "delete from config_pending_approvals where change_comment like 'dbtest %'"
    );
    await dropTestTenants();
    setTrajectoryStore(previousTrajectories);
    resetJobStore();
    await disconnectTestDatabase();
  });

  const runFor = async (kind: string, tenantId: string | null) => {
    await store.enqueue({
      tenantId,
      kind,
      idempotencyKey: `manual:${randomUUID()}`,
      maxAttempts: 1,
      source: "manual",
    });
    return runDue({ budgetMs: 40_000, kinds: [kind], schedule: false });
  };

  it("gdpr.retention-purge erases an account past its retention, in its tenant only", async () => {
    const due = await a.user("erase-me");
    const notYet = await a.user("keep-me");
    const otherTenant = await b.user("erase-me-b");
    await owner(
      `insert into user_deletions (tenant_id, user_id, requested_by, purge_after)
       values ($1, $2, 'test', now() - interval '1 day'),
              ($1, $3, 'test', now() + interval '1 day'),
              ($4, $5, 'test', now() - interval '1 day')`,
      [a.id, due, notYet, b.id, otherTenant]
    );
    const r = await runFor("gdpr.retention-purge", a.id);
    expect(r.succeeded).toBe(1);
    const users = (
      await owner<{ id: string }>("select id from users where id = any($1::uuid[])", [
        [due, notYet, otherTenant],
      ])
    ).rows.map((x) => x.id);
    expect(users.sort()).toEqual([notYet, otherTenant].sort());
    const record = await owner<{ purged_at: Date | null }>(
      "select purged_at from user_deletions where user_id = $1",
      [due]
    );
    expect(record.rows[0].purged_at).toBeInstanceOf(Date);
    const audit = await owner(
      "select 1 from audit_log where tenant_id = $1 and action = 'gdpr_purge_executed' and target_id = $2 and details->>'agent' = 'job:gdpr.retention-purge'",
      [a.id, due]
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("accounts.expire-restrictions steps lapsed restrictions down to warned, in its tenant only", async () => {
    const lapsed = await a.user("lapsed");
    const current = await a.user("current");
    const otherTenant = await b.user("lapsed-b");
    await owner(
      `update users set account_status = 'restricted',
              restricted_until = case when id = $2 then now() + interval '1 day' else now() - interval '1 hour' end
        where id = any($1::uuid[])`,
      [[lapsed, current, otherTenant], current]
    );
    const r = await runFor("accounts.expire-restrictions", a.id);
    expect(r.succeeded).toBe(1);
    const rows = (
      await owner<{ id: string; account_status: string }>(
        "select id, account_status::text from users where id = any($1::uuid[])",
        [[lapsed, current, otherTenant]]
      )
    ).rows;
    const status = Object.fromEntries(rows.map((x) => [x.id, x.account_status]));
    expect(status).toEqual({
      [lapsed]: "warned",
      [current]: "restricted",
      [otherTenant]: "restricted",
    });
  });

  it("agents.trajectory-retention deletes finished trajectories past retention only", async () => {
    const ids = await a.run(() =>
      withTenantTx(async (tx) => {
        const made: Record<string, string> = {};
        for (const [label, status, age] of [
          ["oldDone", "completed", "200 days"],
          ["oldRunning", "running", "200 days"],
          ["newDone", "completed", "1 day"],
        ] as const) {
          const { rows } = await tx.query<{ id: string }>(
            `insert into agent_trajectories (trigger, status, subject_kind, subject_id, updated_at)
             values ('dbtest', $1::trajectory_status, 'agent', 'dbtest-agent', now() - $2::interval)
             returning id`,
            [status, age]
          );
          made[label] = rows[0].id;
        }
        return made;
      })
    );
    const r = await runFor("agents.trajectory-retention", a.id);
    expect(r.succeeded).toBe(1);
    const left = (
      await owner<{ id: string }>(
        "select id from agent_trajectories where id = any($1::uuid[])",
        [Object.values(ids)]
      )
    ).rows.map((x) => x.id);
    expect(left.sort()).toEqual([ids.oldRunning, ids.newDone].sort());
  });

  it("config.expire-approvals expires stale approvals, a tenant's and the platform's", async () => {
    const { rows } = await owner<{
      id: string;
      tenant_id: string | null;
      expires_at: Date;
    }>(
      `insert into config_pending_approvals
         (config_key, proposed_value, change_comment, tenant_id, scope, expires_at)
       values ('signups_enabled', 'false', 'dbtest stale tenant', $1, 'tenant', now() - interval '1 day'),
              ('signups_enabled', 'false', 'dbtest stale platform', null, 'platform', now() - interval '1 day'),
              ('signups_enabled', 'false', 'dbtest fresh', $1, 'tenant', now() + interval '1 day')
       returning id, tenant_id, expires_at`,
      [a.id]
    );
    const r = await runFor("config.expire-approvals", null);
    expect(r.succeeded).toBe(1);
    const status = (
      await owner<{ change_comment: string; status: string }>(
        "select change_comment, status::text from config_pending_approvals where id = any($1::uuid[]) order by change_comment",
        [rows.map((x) => x.id)]
      )
    ).rows;
    expect(status).toEqual([
      { change_comment: "dbtest fresh", status: "pending" },
      { change_comment: "dbtest stale platform", status: "expired" },
      { change_comment: "dbtest stale tenant", status: "expired" },
    ]);
  });
});

dbDescribe("the job queue under the R4–R6 review's hostile cases", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    setJobStore(store);
  });

  afterAll(async () => {
    await owner("delete from jobs where kind like 'dbtest.%'");
    await owner("delete from job_schedules where kind like 'dbtest.%'");
    await owner("delete from job_schedule_outcomes where kind like 'dbtest.%'");
    await dropTestTenants();
    resetJobStore();
    await disconnectTestDatabase();
  });

  afterEach(() => resetJobRegistry());

  it("finding 4: the request role inserts no job, whatever columns it names", async () => {
    for (const sql of [
      "insert into jobs (kind, idempotency_key) values ('dbtest.x', 'k')",
      "insert into jobs (kind, idempotency_key, run_at) values ('dbtest.x', 'k', '1970-01-01')",
      "insert into jobs (kind, idempotency_key, max_attempts) values ('dbtest.x', 'k', 25)",
    ]) {
      await expect(a.run(() => withTenantTx((tx) => tx.query(sql)))).rejects.toThrow(
        /permission denied/
      );
    }
    // Its own tenant's jobs stay readable.
    const kind = K("readable");
    registerJob(kind, async () => undefined, { description: "Readable." });
    await a.run(() => enqueueJob(kind, { idempotencyKey: "r" }));
    const seen = await a.run(() =>
      withTenantTx((tx) => tx.query("select 1 from jobs where kind = $1", [kind]))
    );
    expect(seen.rowCount).toBe(1);
  });

  it("findings 5 and 6: 300 000 parked jobs and 300 000 of one busy tenant leave the claim fast and fair", async () => {
    const kind = K("perf");
    const s = await createTestTenant();
    await owner("update tenants set status = 'suspended' where id = $1", [s.id]);
    // Bulk setup, past the owner connection's statement timeout.
    const bulk = (sql: string, values: unknown[]) =>
      withOwnerTx("operator", async (tx) => {
        await tx.query("set local statement_timeout = 0");
        await tx.query(sql, values);
      });
    try {
      await bulk(
        `insert into jobs (tenant_id, kind, idempotency_key)
           select $1::uuid, $2, 's' || i from generate_series(1, 300000) i`,
        [s.id, kind]
      );
      await bulk(
        `insert into jobs (tenant_id, kind, idempotency_key, run_at)
           select $1::uuid, $2, 'a' || i, now() from generate_series(1, 300000) i`,
        [a.id, kind]
      );
      await new Promise((r) => setTimeout(r, 20));
      await owner(
        "insert into jobs (tenant_id, kind, idempotency_key) values ($1::uuid, $2, 'b1')",
        [b.id, kind]
      );
      await bulk("analyze jobs", []);
      const parked = await owner<{ n: number }>(
        "select count(*)::int as n from jobs where kind = $1 and tenant_id = $2 and status = 'parked'",
        [kind, s.id]
      );
      expect(parked.rows[0].n).toBe(300_000);
      // Bounded: a claim of 10 reads a few dozen rows of jobs, whatever else is queued or
      // parked — it was every one of a tenant's 300 000 rows when the tenant probe could be
      // served by jobs_tenant_created_idx (CI run 40098437851), and 423 ms of scanning before
      // parking. The bound is tenants × kinds × limit with room for the suites' own rows.
      expect(await rowsOfJobsAClaimReads([kind], 10)).toBeLessThan(2_000);
      let firstBatch: (string | null)[] = [];
      for (let i = 0; i < 3; i++) {
        const claimed = await store.claim({
          workerId: `dbtest-perf-${i}`,
          kinds: [kind],
          limit: 10,
          leaseMs: 60_000,
        });
        if (i === 0) firstBatch = claimed.map((j) => j.tenantId);
        expect(claimed).toHaveLength(10);
      }
      // Fair: B's one job, enqueued after A's 300 000, is in the first batch.
      expect(firstBatch).toContain(b.id);
      expect(firstBatch).not.toContain(s.id);
    } finally {
      await bulk("delete from jobs where kind = $1", [kind]);
    }
  }, 120_000);

  it("finding 7: the GDPR purge reaches and runs for a suspended tenant; other duties do not", async () => {
    const s = await createTestTenant();
    const due = await s.user("erase-while-suspended");
    await owner(
      `insert into user_deletions (tenant_id, user_id, requested_by, purge_after)
       values ($1, $2, 'test', now() - interval '1 day')`,
      [s.id, due]
    );
    await owner("update tenants set status = 'suspended' where id = $1", [s.id]);
    const fan = (kind: string, runsForSuspended: boolean) =>
      store.fanOut({
        kind,
        scope: "each-tenant",
        idempotencyKey: `manual:${randomUUID()}`,
        maxAttempts: 1,
        source: "manual",
        runsForSuspended,
        tenantIds: [s.id],
      });
    expect(await fan("gdpr.retention-purge", true)).toBe(1);
    expect(await fan("accounts.expire-restrictions", false)).toBe(0);
    const r = await runDue({
      budgetMs: 40_000,
      kinds: ["gdpr.retention-purge", "accounts.expire-restrictions"],
      schedule: false,
    });
    expect(r).toMatchObject({ claimed: 1, succeeded: 1 });
    const left = await owner("select 1 from users where id = $1", [due]);
    expect(left.rowCount).toBe(0);
    await owner("update tenants set status = 'active' where id = $1", [s.id]);
  });

  it("finding 8: one tenant's success never overwrites another's failure on the schedule", async () => {
    const kind = K("outcome");
    registerJob(
      kind,
      async (ctx) => {
        if (ctx.tenantId === a.id) throw new Error("A's work failed");
      },
      {
        description: "Fails for A.",
        maxAttempts: 1,
        schedule: {
          scope: "each-tenant",
          defaultIntervalMinutes: 60,
          minIntervalMinutes: 15,
          maxIntervalMinutes: 1440,
        },
      }
    );
    await store.takeScheduleSlot({
      kind,
      scope: "each-tenant",
      intervalMs: 3_600_000,
      maxAttempts: 1,
      now: new Date(),
      tenantIds: [],
    });
    // A's job is due first, so B's success is the last to finish.
    await store.enqueue({
      tenantId: a.id,
      kind,
      idempotencyKey: "s1",
      maxAttempts: 1,
      source: "schedule",
    });
    await new Promise((r) => setTimeout(r, 20));
    await store.enqueue({
      tenantId: b.id,
      kind,
      idempotencyKey: "s1",
      maxAttempts: 1,
      source: "schedule",
    });
    const r = await runDue({ budgetMs: 40_000, kinds: [kind], schedule: false });
    expect(r).toMatchObject({ dead: 1, succeeded: 1 });
    const state = (await store.listSchedules()).find((x) => x.kind === kind);
    expect(state).toMatchObject({
      lastStatus: "dead",
      lastError: "The job failed with an unexpected Error.",
      reported: 2,
      failing: 1,
    });
    // runDue may wait for the claim lock while other database suites run jobs in parallel.
  }, 60_000);

  // Finding 9 (re-applying 050 keeps a dual-control key an operator removed removed) is proved by
  // the migration replay (scripts/migration-replay.sh, "A third application: still removed"), not
  // here: re-running a migration's DDL while the other database suites run in parallel takes
  // table locks that deadlock with them (CI run 40098437851).
});
