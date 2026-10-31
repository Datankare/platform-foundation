/**
 * @jest-environment node
 */
/**
 * __tests__/db/status-lifecycle.db.test.ts — the status-lifecycle register holds to the schema,
 * and every reaped state is left (TASK-193; platform/assurance/status-lifecycle.ts)
 *
 *   1. Every status column of the replayed schema (a column named `status`, `*_status` or `state`)
 *      is in the register or in NOT_A_LIFECYCLE; every value its enum or check allows is a state
 *      the register classifies, and the register names no value the schema does not allow.
 *   2. One row in each state the register says a reaper leaves, aged past its bound, is moved out
 *      of it (or deleted) by that reaper: the job run through runDue in the test's tenant (the
 *      each-tenant duties), or the platform job's own function scoped to the test's tenant (an
 *      unscoped platform sweep would take a parallel suite's rows, review 11 L-5). A reaped state
 *      with no seeder here fails — so a new state in the register is aged here, too.
 *
 * Shown failing on the code before TASK-193 (with the register copied in): trajectories running,
 * paused, awaiting_retry and indeterminate stayed; a proposed hold stayed proposed; an approved,
 * unapplied configuration approval stayed approved; a child's account pending or denied consent
 * stayed.
 */

import { randomUUID } from "node:crypto";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { withOwnerTx } from "@/platform/data";
import {
  PostgresJobStore,
  registerJob,
  resetJobStore,
  runDue,
  setJobStore,
} from "@/platform/jobs";
import {
  setTrajectoryStore,
  type TrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import {
  PostgresReviewQueueStore,
  setReviewQueueStore,
} from "@/platform/moderation/review-store";
import type { ReviewQueueStore } from "@/platform/moderation/review-types";
import { expireStaleApprovals } from "@/platform/admin/config-approval";
import { clearConfigCache } from "@/platform/auth/platform-config";
import { NOT_A_LIFECYCLE, STATUS_LIFECYCLE } from "@/platform/assurance/status-lifecycle";

const store = new PostgresJobStore();
const RUN = randomUUID().slice(0, 8);

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

/** Reaped states proved elsewhere, with where and why not here. */
const AGED_ELSEWHERE: Readonly<Record<string, string>> = {
  "tenants.status=deleted":
    "__tests__/db/tenant-lifecycle.db.test.ts purges a deleted tenant past purge_after; the purge is platform-wide, so running it here would purge other suites' deleted tenants",
};

dbDescribe("the status-lifecycle register against the schema (TASK-193)", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);

  it("classifies every status column the schema has, and every value it allows", async () => {
    const { rows: columns } = await owner<{
      table_name: string;
      column_name: string;
      labels: string[] | null;
      checks: string[] | null;
    }>(
      `select c.table_name, c.column_name,
              (select array_agg(e.enumlabel::text order by e.enumsortorder)
                 from pg_type t join pg_enum e on e.enumtypid = t.oid
                where t.typname = c.udt_name) as labels,
              (select array_agg(pg_get_constraintdef(k.oid))
                 from pg_constraint k
                where k.conrelid = format('public.%I', c.table_name)::regclass
                  and k.contype = 'c'
                  and pg_get_constraintdef(k.oid) ~ ('\\(\\(' || c.column_name || ' = ANY')) as checks
         from information_schema.columns c
         join information_schema.tables tb
           on tb.table_schema = c.table_schema and tb.table_name = c.table_name
          and tb.table_type = 'BASE TABLE'
        where c.table_schema = 'public'
          and (c.column_name ~ '(^|_)status$' or c.column_name = 'state')
        order by 1, 2`
    );
    expect(columns.length).toBeGreaterThan(10); // self-test
    const found = new Set<string>();
    const problems: string[] = [];
    for (const c of columns) {
      const key = `${c.table_name}.${c.column_name}`;
      found.add(key);
      if (NOT_A_LIFECYCLE[key]) continue;
      const states = STATUS_LIFECYCLE[key];
      if (!states) {
        problems.push(`${key}: not in the register`);
        continue;
      }
      const allowed =
        c.labels ??
        (c.checks ?? []).flatMap((def) =>
          [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1])
        );
      if (allowed.length === 0) continue; // a text column with no check: the register is its list
      for (const v of allowed) {
        if (!states[v])
          problems.push(`${key}: '${v}' is allowed by the schema, not classified`);
      }
      for (const v of Object.keys(states)) {
        if (!allowed.includes(v))
          problems.push(`${key}: '${v}' is classified, not allowed`);
      }
    }
    for (const key of [
      ...Object.keys(STATUS_LIFECYCLE),
      ...Object.keys(NOT_A_LIFECYCLE),
    ]) {
      // An app's own table is not in this schema in platform-foundation: only its own tables.
      if (!found.has(key)) problems.push(`${key}: in the register, not in the schema`);
    }
    expect(problems).toEqual([]);
  });
});

dbDescribe("every reaped state is left once past its bound (TASK-193)", () => {
  let t: TestTenant;
  let previousTrajectories: TrajectoryStore;
  let previousReviews: ReviewQueueStore;
  const seeded = new Set<string>();
  const kind = `dbtest.lifecycle${RUN}`;

  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    setJobStore(store);
    previousTrajectories = setTrajectoryStore(new PostgresTrajectoryStore());
    previousReviews = setReviewQueueStore(new PostgresReviewQueueStore());
    registerJob(kind, async () => undefined, {
      description: "Finishes at once (status-lifecycle aging).",
      timeoutMs: 5_000,
    });
  });

  afterAll(async () => {
    await owner("delete from jobs where kind = $1", [kind]);
    await owner("delete from config_pending_approvals where change_comment like $1", [
      `dbtest lifecycle ${RUN}%`,
    ]);
    await dropTestTenants();
    setTrajectoryStore(previousTrajectories);
    setReviewQueueStore(previousReviews);
    resetJobStore();
    await disconnectTestDatabase();
  });

  const runFor = async (jobKind: string) => {
    await store.enqueue({
      tenantId: t.id,
      kind: jobKind,
      idempotencyKey: `manual:${randomUUID()}`,
      maxAttempts: 1,
      source: "manual",
    });
    return runDue({ budgetMs: 40_000, kinds: [jobKind], schedule: false });
  };

  it("agents.trajectory-retention: every open trajectory with no hold, past agent.trajectory.abandon_after_hours", async () => {
    const ids: Record<string, string> = {};
    for (const status of ["running", "paused", "awaiting_retry", "indeterminate"]) {
      const { rows } = await owner<{ id: string }>(
        `insert into agent_trajectories (tenant_id, trigger, status, subject_kind, subject_id, updated_at)
         values ($1, 'dbtest-lifecycle', $2::trajectory_status, 'agent', 'dbtest-agent', now() - interval '2 days')
         returning id`,
        [t.id, status]
      );
      ids[status] = rows[0].id;
      seeded.add(`agent_trajectories.status=${status}`);
    }
    expect((await runFor("agents.trajectory-retention")).succeeded).toBe(1);
    const { rows } = await owner<{ id: string; status: string }>(
      "select id, status::text from agent_trajectories where id = any($1::uuid[])",
      [Object.values(ids)]
    );
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "failed", "failed"]);
  });

  it("config.expire-approvals: holds never decided, unused approvals, lost runs, unapplied approvals", async () => {
    const trajectory = randomUUID();
    const { rows: holds } = await owner<{ id: string; status: string }>(
      `insert into proposals (tenant_id, operation_id, session_id, trajectory_id, label, status,
                              actor_id, actor_role, effective_risk, created_at, decided_at, updated_at)
       values ($1, $2 || '-p', 's', $3, 'dbtest', 'proposed', 'a', 'agent', 'restricted',
               now() - interval '30 days', null, now() - interval '30 days'),
              ($1, $2 || '-a', 's', $3, 'dbtest', 'approved', 'a', 'agent', 'restricted',
               now() - interval '30 days', now() - interval '30 days', now() - interval '30 days'),
              ($1, $2 || '-e', 's', $3, 'dbtest', 'executing', 'a', 'agent', 'restricted',
               now() - interval '1 day', now() - interval '1 day', now() - interval '1 hour')
       returning id, status`,
      [t.id, `op-${RUN}`, trajectory]
    );
    for (const s of ["proposed", "approved", "executing"])
      seeded.add(`proposals.status=${s}`);
    const { rows: approvals } = await owner<{ id: string }>(
      `insert into config_pending_approvals
         (config_key, proposed_value, change_comment, tenant_id, scope, status, reviewed_at, expires_at)
       values ('signups_enabled', 'false', $2, $1, 'tenant', 'approved', now() - interval '1 hour',
               now() + interval '1 day')
       returning id`,
      [t.id, `dbtest lifecycle ${RUN} unapplied`]
    );
    seeded.add("config_pending_approvals.status=approved");
    await expireStaleApprovals({ tenantIds: [t.id] });
    const { rows: after } = await owner<{ id: string; status: string }>(
      "select id, status from proposals where id = any($1::uuid[]) order by operation_id",
      [holds.map((h) => h.id)]
    );
    expect(Object.fromEntries(after.map((r) => [r.id, r.status]))).toEqual(
      Object.fromEntries(
        holds.map((h) => [h.id, h.status === "executing" ? "indeterminate" : "rejected"])
      )
    );
    const { rows: reopened } = await owner<{ status: string }>(
      "select status::text from config_pending_approvals where id = $1::uuid",
      [approvals[0].id]
    );
    expect(reopened[0].status).toBe("pending");
  });

  it("config.expire-approvals: an approval is marked applied only by its own change's history (round 1, L2)", async () => {
    const reviewer = await t.user(`reviewer-${RUN}`);
    const approval = async (label: string) =>
      (
        await owner<{ id: string }>(
          `insert into config_pending_approvals
             (config_key, current_value, proposed_value, change_comment, tenant_id, scope, status,
              reviewed_by, reviewed_at, expires_at)
           values ('signups_enabled', 'true', 'false', $2, $1, 'tenant', 'approved', $3::uuid,
                   now() - interval '1 hour', now() + interval '1 day')
           returning id`,
          [t.id, `dbtest lifecycle ${RUN} ${label}`, reviewer]
        )
      ).rows[0].id;
    const history = (previous: string, value: string) =>
      owner(
        `insert into platform_config_history
           (config_key, previous_value, new_value, changed_by, change_comment, tenant_id, scope, created_at)
         values ('signups_enabled', $2::jsonb, $3::jsonb, $4::uuid, 'dbtest', $1, 'tenant',
                 now() - interval '50 minutes')`,
        [t.id, previous, value, reviewer]
      );
    const applied = await approval("applied");
    await history("true", "false");
    await expireStaleApprovals({ tenantIds: [t.id] });
    const other = await approval("other-write");
    // The reviewer wrote the same key since — but another value: not this change.
    await owner(
      "delete from platform_config_history where tenant_id = $1 and change_comment = 'dbtest'",
      [t.id]
    );
    await history("true", "true");
    await expireStaleApprovals({ tenantIds: [t.id] });
    const { rows } = await owner<{ id: string; status: string; applied: boolean }>(
      `select id, status::text, applied_at is not null as applied
         from config_pending_approvals where id = any($1::uuid[])`,
      [[applied, other]]
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.applied]]))).toEqual({
      [applied]: ["approved", true],
      [other]: ["pending", false],
    });
  });

  it("gdpr.retention-purge: a child's account whose consent is pending or denied past coppa.consent_expiry_days", async () => {
    const pending = await t.user(`child-pending-${RUN}`);
    const denied = await t.user(`child-denied-${RUN}`);
    await owner(
      `update users set date_of_birth = current_date - interval '10 years', age_verified = true,
              age_verified_at = now() - interval '30 days', coppa_enforcement_active = true,
              parental_consent_status = case when id = $1 then 'pending' else 'denied' end::parental_consent_status
        where id = any($2::uuid[])`,
      [pending, [pending, denied]]
    );
    seeded.add("users.parental_consent_status=pending");
    seeded.add("users.parental_consent_status=denied");
    const remaining = async () =>
      (
        await owner<{ id: string }>(
          "select id from users where id = any($1::uuid[]) and deleted_at is null",
          [[pending, denied]]
        )
      ).rows.length;
    // Off (the default — review round 1, item 4): nothing is erased.
    expect((await runFor("gdpr.retention-purge")).succeeded).toBe(1);
    expect(await remaining()).toBe(2);
    // On (an operator's switch, with the parental-consent flow): both are erased.
    await owner(
      "update platform_config set value = 'true' where key = 'coppa.consent_expiry_enabled'"
    );
    try {
      clearConfigCache();
      expect((await runFor("gdpr.retention-purge")).succeeded).toBe(1);
    } finally {
      await owner(
        "update platform_config set value = 'false' where key = 'coppa.consent_expiry_enabled'"
      );
      clearConfigCache();
    }
    const { rows } = await owner("select id from users where id = any($1::uuid[])", [
      [pending, denied],
    ]);
    expect(rows).toEqual([]);
  });

  it("agents.trajectory-retention: a workflow's trajectory is the user's to continue past the request bound (M1)", async () => {
    // A workflow's trajectory carries its goal as the trigger ("analyze": the core's). Paused
    // after an approved, executed step, untouched for two days: kept, still paused, so the user
    // can continue it. Untouched past agent.workflow.abandon_after_days (30): ended.
    const insert = async (age: string) =>
      (
        await owner<{ id: string }>(
          `insert into agent_trajectories (tenant_id, trigger, status, subject_kind, subject_id, updated_at)
           values ($1, 'analyze', 'paused', 'agent', 'dbtest-agent', now() - $2::interval)
           returning id`,
          [t.id, age]
        )
      ).rows[0].id;
    const recent = await insert("2 days");
    const stale = await insert("40 days");
    await owner(
      `insert into proposals (tenant_id, operation_id, session_id, trajectory_id, label, status,
                              actor_id, actor_role, effective_risk, created_at, decided_at, updated_at)
       values ($1, $2, 's', $3, 'dbtest', 'executed', 'a', 'agent', 'restricted',
               now() - interval '2 days', now() - interval '2 days', now() - interval '2 days')`,
      [t.id, `op-wf-${RUN}`, recent]
    );
    expect((await runFor("agents.trajectory-retention")).succeeded).toBe(1);
    const { rows } = await owner<{ id: string; status: string }>(
      "select id, status::text from agent_trajectories where id = any($1::uuid[])",
      [[recent, stale]]
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [recent]: "paused",
      [stale]: "failed",
    });
  });

  it("accounts.expire-restrictions: a restriction or suspension past its end", async () => {
    const restricted = await t.user(`restricted-${RUN}`);
    const suspended = await t.user(`suspended-${RUN}`);
    await owner(
      `update users set account_status = 'restricted', restricted_until = now() - interval '1 hour' where id = $1;`,
      [restricted]
    );
    await owner(
      `update users set account_status = 'suspended', suspended_until = now() - interval '1 hour' where id = $1`,
      [suspended]
    );
    seeded.add("users.account_status=restricted");
    seeded.add("users.account_status=suspended");
    expect((await runFor("accounts.expire-restrictions")).succeeded).toBe(1);
    const { rows } = await owner<{ account_status: string }>(
      "select account_status::text from users where id = any($1::uuid[])",
      [[restricted, suspended]]
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) => r.account_status !== "restricted" && r.account_status !== "suspended"
      )
    ).toBe(true);
  });

  it("moderation.release-claims: a review claim past moderation.review_claim_timeout_hours", async () => {
    const target = await t.user(`reviewed-${RUN}`);
    const { rows } = await owner<{ id: string }>(
      `insert into review_queue (tenant_id, source, moderation_result, target_user_id, request_id,
                                 status, claimed_by, claimed_at)
       values ($1, 'escalation', '{}'::jsonb, $2::uuid, 'r-lifecycle', 'claimed', 'someone',
               now() - interval '3 days')
       returning id`,
      [t.id, target]
    );
    seeded.add("review_queue.status=claimed");
    expect((await runFor("moderation.release-claims")).succeeded).toBe(1);
    const { rows: after } = await owner<{ status: string }>(
      "select status from review_queue where id = $1::uuid",
      [rows[0].id]
    );
    expect(after[0].status).toBe("pending");
  });

  it("the job runner: a queued job is run, and a running one whose lease lapsed is taken back", async () => {
    await store.enqueue({
      tenantId: t.id,
      kind,
      idempotencyKey: `queued-${RUN}`,
      maxAttempts: 2,
      source: "manual",
    });
    await store.enqueue({
      tenantId: t.id,
      kind,
      idempotencyKey: `lost-${RUN}`,
      maxAttempts: 2,
      source: "manual",
    });
    await owner(
      `update jobs set status = 'running', attempts = 1, locked_until = now() - interval '1 minute',
              locked_by = 'a-dead-worker', lease_token = gen_random_uuid(), started_at = now() - interval '10 minutes'
        where kind = $1 and idempotency_key = $2`,
      [kind, `lost-${RUN}`]
    );
    seeded.add("jobs.status=queued");
    seeded.add("jobs.status=running");
    const r = await runDue({ budgetMs: 40_000, kinds: [kind], schedule: false });
    expect(r.succeeded).toBe(2);
    const { rows } = await owner<{ status: string }>(
      "select status from jobs where kind = $1 order by idempotency_key",
      [kind]
    );
    expect(rows.map((x) => x.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("every reaped state in the register was aged here (or names where it is)", () => {
    const reaped = Object.entries(STATUS_LIFECYCLE).flatMap(([column, states]) =>
      Object.entries(states)
        .filter(([, l]) => "reaper" in l)
        .map(([state]) => `${column}=${state}`)
    );
    const missing = reaped.filter((k) => !seeded.has(k) && !AGED_ELSEWHERE[k]);
    expect(missing).toEqual([]);
  });
});
