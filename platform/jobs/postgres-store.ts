/**
 * platform/jobs/postgres-store.ts — the durable job store (migration 050, ADR-056 D2)
 *
 * Jobs are rows in `jobs`; claiming is job_claim (round-robin across tenants, FOR UPDATE SKIP
 * LOCKED, a lease per job), the one step that reads every tenant's work. Which connection each
 * step uses:
 *
 *   every enqueue                       withOwnerTx("job-claim") — after platform/jobs/queue.ts
 *                                        bound the job to the caller's tenant and the kind's
 *                                        scope (the request role inserts no job: migration 050)
 *   claim, settle, schedule, fan-out    withOwnerTx("job-claim") — the runner and "run now"
 *   operators' views and actions        withOwnerTx("operator") — through audited operator routes
 *   prune                               withOwnerTx("platform-job") — the jobs.prune job
 *   a tenant's own history              withTenantTx — its row-level security shows it its own
 *
 * Every settle names the lease token it was given: a worker whose lease lapsed (and whose job
 * another worker reclaimed, or job_claim dead-lettered) changes nothing. The schedule slot uses
 * the database's clock, so instances whose clocks differ agree on what is due.
 *
 * @module platform/jobs
 */

import { withOwnerTx, withTenantTx, type Tx } from "@/platform/data";
import { peekTenant } from "@/platform/tenancy/context";
import type {
  ClaimedJob,
  DiscardOutcome,
  EnqueueRequest,
  EnqueueResult,
  FanOutRequest,
  JobKind,
  JobListFilter,
  JobRecord,
  JobSource,
  JobStatus,
  JobStore,
  ReplayOutcome,
  ScheduleOutcome,
  ScheduleSlotRequest,
  ScheduleSlotResult,
  ScheduleState,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ClaimRow {
  id: string;
  tenant_id: string | null;
  kind: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  lease_token: string;
  locked_until: Date;
  source: string;
}

interface JobRow {
  id: string;
  tenant_id: string | null;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  source: string;
  run_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

interface ScheduleRow {
  kind: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_enqueued: number;
  last_status: string | null;
  last_error: string | null;
  last_finished_at: Date | null;
  reported: number;
  failing: number;
  queued: number;
  running: number;
  dead: number;
}

const SOURCES: readonly JobSource[] = ["enqueue", "schedule", "manual", "replay"];
const STATUSES: readonly JobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "dead",
  "parked",
];
const asSource = (s: string): JobSource =>
  (SOURCES as readonly string[]).includes(s) ? (s as JobSource) : "enqueue";
const asStatus = (s: string): JobStatus =>
  (STATUSES as readonly string[]).includes(s) ? (s as JobStatus) : "queued";
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const clampLimit = (n: number | undefined) =>
  Math.min(Math.max(Math.floor(n ?? 50), 1), 200);

function toRecord(r: JobRow): JobRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    status: asStatus(r.status),
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    source: asSource(r.source),
    runAt: r.run_at.toISOString(),
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    finishedAt: iso(r.finished_at),
  };
}

const LIST_SQL = `select id, tenant_id, kind, status, attempts, max_attempts, source, run_at, last_error, created_at, updated_at, finished_at
     from jobs
    where ($1::text is null or status = $1)
      and ($2::text is null or kind = $2)
    order by updated_at desc, id desc
    limit $3::int`;

export class PostgresJobStore implements JobStore {
  async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const payload = JSON.stringify(request.payload ?? {});
    // The database clamps a past run_at to now() (050's jobs_on_write), on its own clock.
    const runAt = request.runAt ? request.runAt.toISOString() : null;
    return withOwnerTx("job-claim", async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `insert into jobs (tenant_id, kind, payload, idempotency_key, run_at, max_attempts, source,
                           runs_for_suspended)
         values ($1::uuid, $2, $3::jsonb, $4, coalesce($5::timestamptz, now()), $6::int, $7,
                 $8::boolean)
         on conflict (tenant_id, kind, idempotency_key) do nothing
         returning id`,
        [
          request.tenantId,
          request.kind,
          payload,
          request.idempotencyKey,
          runAt,
          request.maxAttempts,
          request.source,
          request.runsForSuspended ?? false,
        ]
      );
      if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
      const found = await tx.query<{ id: string }>(
        `select id from jobs
          where tenant_id is not distinct from $1::uuid and kind = $2 and idempotency_key = $3`,
        [request.tenantId, request.kind, request.idempotencyKey]
      );
      return { id: found.rows[0].id, created: false };
    });
  }

  async claim(options: {
    readonly workerId: string;
    readonly kinds: readonly JobKind[];
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<ClaimedJob[]> {
    if (options.kinds.length === 0) return [];
    const leaseSeconds = Math.min(3600, Math.max(5, Math.ceil(options.leaseMs / 1000)));
    const { rows } = await withOwnerTx("job-claim", (tx) =>
      tx.query<ClaimRow>(
        `select id, tenant_id, kind, payload, attempts, max_attempts, lease_token, locked_until, source
           from public.job_claim($1, $2::text[], $3::int, $4::int)`,
        [options.workerId, [...options.kinds], options.limit, leaseSeconds]
      )
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      kind: r.kind,
      payload: Object.freeze({ ...(r.payload ?? {}) }),
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      source: asSource(r.source),
      leaseToken: r.lease_token,
      lockedUntil: r.locked_until,
    }));
  }

  private async settle(
    job: ClaimedJob,
    sql: string,
    values: readonly unknown[]
  ): Promise<boolean> {
    if (!UUID.test(job.id) || !UUID.test(job.leaseToken)) return false;
    const { rowCount } = await withOwnerTx("job-claim", (tx) =>
      tx.query(sql, [job.id, job.leaseToken, ...values])
    );
    return rowCount === 1;
  }

  complete(job: ClaimedJob): Promise<boolean> {
    return this.settle(
      job,
      `update jobs set status = 'succeeded', last_error = null, locked_until = null,
              locked_by = null, lease_token = null, finished_at = now(), updated_at = now()
        where id = $1::uuid and status = 'running' and lease_token = $2::uuid`,
      []
    );
  }

  release(job: ClaimedJob): Promise<boolean> {
    return this.settle(
      job,
      `update jobs set status = 'queued', attempts = greatest(attempts - 1, 0), run_at = now(),
              locked_until = null, locked_by = null, lease_token = null, updated_at = now()
        where id = $1::uuid and status = 'running' and lease_token = $2::uuid`,
      []
    );
  }

  extendLease(job: ClaimedJob, leaseMs: number): Promise<boolean> {
    const seconds = Math.min(3600, Math.max(5, Math.ceil(leaseMs / 1000)));
    return this.settle(
      job,
      `update jobs set locked_until = now() + make_interval(secs => $3::int), updated_at = now()
        where id = $1::uuid and status = 'running' and lease_token = $2::uuid`,
      [seconds]
    );
  }

  retry(job: ClaimedJob, error: string, runAt: Date): Promise<boolean> {
    return this.settle(
      job,
      `update jobs set status = 'queued', last_error = $3, run_at = $4::timestamptz,
              locked_until = null, locked_by = null, lease_token = null, updated_at = now()
        where id = $1::uuid and status = 'running' and lease_token = $2::uuid`,
      [error, runAt.toISOString()]
    );
  }

  bury(job: ClaimedJob, error: string): Promise<boolean> {
    return this.settle(
      job,
      `update jobs set status = 'dead', last_error = $3, locked_until = null, locked_by = null,
              lease_token = null, finished_at = now(), updated_at = now()
        where id = $1::uuid and status = 'running' and lease_token = $2::uuid`,
      [error]
    );
  }

  async takeScheduleSlot(
    request: ScheduleSlotRequest
  ): Promise<ScheduleSlotResult | null> {
    const intervalSeconds = Math.max(1, Math.round(request.intervalMs / 1000));
    return withOwnerTx("job-claim", async (tx: Tx) => {
      await tx.query(
        "insert into job_schedules (kind) values ($1) on conflict (kind) do nothing",
        [request.kind]
      );
      // Taken by one caller: the row lock serialises two, and the second finds it not due. Due
      // at the recorded next time or at the last run plus the interval in force now, whichever is
      // earlier — so an interval shortened since the last slot (a governed change, applied
      // whenever and however it was approved) takes effect at the next tick, not a slot later.
      const taken = await tx.query<{ slot: Date }>(
        `update job_schedules
            set next_run_at = now() + make_interval(secs => $2::int), last_run_at = now(),
                updated_at = now()
          where kind = $1
            and least(next_run_at,
                      coalesce(last_run_at + make_interval(secs => $2::int), next_run_at)) <= now()
          returning last_run_at as slot`,
        [request.kind, intervalSeconds]
      );
      const slot = taken.rows[0]?.slot;
      if (!slot) return null;
      const enqueued = await this.insertFanOut(tx, {
        kind: request.kind,
        scope: request.scope,
        idempotencyKey: `schedule:${slot.toISOString()}`,
        maxAttempts: request.maxAttempts,
        source: "schedule",
        runsForSuspended: request.runsForSuspended ?? false,
        ...(request.tenantIds ? { tenantIds: request.tenantIds } : {}),
      });
      await tx.query("update job_schedules set last_enqueued = $2::int where kind = $1", [
        request.kind,
        enqueued,
      ]);
      return { slot, enqueued };
    });
  }

  /** One statement: a platform job, or one job per tenant reached (active, or suspended too). */
  private async insertFanOut(tx: Tx, request: FanOutRequest): Promise<number> {
    const inserted =
      request.scope === "platform"
        ? await tx.query(
            `insert into jobs (tenant_id, kind, idempotency_key, max_attempts, source)
             values (null, $1, $2, $3::int, $4)
             on conflict (tenant_id, kind, idempotency_key) do nothing`,
            [request.kind, request.idempotencyKey, request.maxAttempts, request.source]
          )
        : await tx.query(
            `insert into jobs (tenant_id, kind, idempotency_key, max_attempts, source,
                               runs_for_suspended)
             select t.id, $1, $2, $3::int, $4, $6::boolean
               from tenants t
              where (t.status = 'active' or ($6::boolean and t.status = 'suspended'))
                and ($5::uuid[] is null or t.id = any ($5::uuid[]))
             on conflict (tenant_id, kind, idempotency_key) do nothing`,
            [
              request.kind,
              request.idempotencyKey,
              request.maxAttempts,
              request.source,
              request.tenantIds ? [...request.tenantIds] : null,
              request.runsForSuspended,
            ]
          );
    return inserted.rowCount;
  }

  async fanOut(request: FanOutRequest): Promise<number> {
    return withOwnerTx("job-claim", (tx) => this.insertFanOut(tx, request));
  }

  async recordScheduleOutcome(
    kind: JobKind,
    tenantId: string | null,
    status: ScheduleOutcome,
    error: string | null
  ): Promise<void> {
    await withOwnerTx("job-claim", (tx) =>
      tx.query(
        `insert into job_schedule_outcomes (tenant_id, kind, status, last_error, finished_at)
         values ($1::uuid, $2, $3, $4, now())
         on conflict (tenant_id, kind)
           do update set status = excluded.status, last_error = excluded.last_error,
                         finished_at = excluded.finished_at`,
        [tenantId, kind, status, error]
      )
    );
  }

  async listSchedules(): Promise<ScheduleState[]> {
    const { rows } = await withOwnerTx("operator", (tx) =>
      tx.query<ScheduleRow>(
        `select s.kind, s.next_run_at, s.last_run_at, s.last_enqueued,
                o.worst as last_status, o.error as last_error, o.finished as last_finished_at,
                coalesce(o.reported, 0)::int as reported, coalesce(o.failing, 0)::int as failing,
                (select count(*) from jobs j where j.kind = s.kind and j.status = 'queued')::int as queued,
                (select count(*) from jobs j where j.kind = s.kind and j.status = 'running')::int as running,
                (select count(*) from jobs j where j.kind = s.kind and j.status = 'dead')::int as dead
           from job_schedules s
           left join lateral (
             select count(*) as reported,
                    count(*) filter (where x.status <> 'succeeded') as failing,
                    max(x.finished_at) as finished,
                    (array_agg(x.status order by x.severity desc, x.finished_at desc))[1] as worst,
                    (array_agg(x.last_error order by x.severity desc, x.finished_at desc)
                       filter (where x.status <> 'succeeded'))[1] as error
               from (select o.status, o.last_error, o.finished_at,
                            case o.status when 'dead' then 2 when 'retrying' then 1 else 0 end
                              as severity
                       from job_schedule_outcomes o
                       left join tenants t on t.id = o.tenant_id
                      where o.kind = s.kind and (o.tenant_id is null or t.status <> 'deleted')) x
           ) o on true
          order by s.kind`
      )
    );
    return rows.map((r) => ({
      kind: r.kind,
      nextRunAt: iso(r.next_run_at),
      lastRunAt: iso(r.last_run_at),
      lastEnqueued: r.last_enqueued,
      lastStatus:
        r.last_status === "succeeded" ||
        r.last_status === "retrying" ||
        r.last_status === "dead"
          ? r.last_status
          : null,
      lastError: r.last_error,
      lastFinishedAt: iso(r.last_finished_at),
      reported: r.reported,
      failing: r.failing,
      queued: r.queued,
      running: r.running,
      dead: r.dead,
    }));
  }

  async listScheduleTimes(): Promise<
    { kind: JobKind; lastRunAt: string | null; nextRunAt: string | null }[]
  > {
    const { rows } = await withOwnerTx("operator", (tx) =>
      tx.query<{ kind: string; last_run_at: Date | null; next_run_at: Date | null }>(
        "select kind, last_run_at, next_run_at from job_schedules order by kind"
      )
    );
    return rows.map((r) => ({
      kind: r.kind,
      lastRunAt: iso(r.last_run_at),
      nextRunAt: iso(r.next_run_at),
    }));
  }

  async listJobs(filter: JobListFilter = {}): Promise<JobRecord[]> {
    const { rows } = await withOwnerTx("operator", (tx) =>
      tx.query<JobRow>(LIST_SQL, [
        filter.status ?? null,
        filter.kind ?? null,
        clampLimit(filter.limit),
      ])
    );
    return rows.map(toRecord);
  }

  async listTenantJobs(filter: JobListFilter = {}): Promise<JobRecord[]> {
    if (!peekTenant()) return [];
    const { rows } = await withTenantTx((tx) =>
      tx.query<JobRow>(LIST_SQL, [
        filter.status ?? null,
        filter.kind ?? null,
        clampLimit(filter.limit),
      ])
    );
    return rows.map(toRecord);
  }

  async getJob(id: string): Promise<JobRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await withOwnerTx("operator", (tx) =>
      tx.query<JobRow>(
        `select id, tenant_id, kind, status, attempts, max_attempts, source, run_at, last_error,
                created_at, updated_at, finished_at
           from jobs where id = $1::uuid`,
        [id]
      )
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async replay(id: string): Promise<ReplayOutcome> {
    if (!UUID.test(id)) return "not_found";
    return withOwnerTx("operator", async (tx) => {
      const r = await tx.query(
        `update jobs set status = 'queued', attempts = 0, run_at = now(), source = 'replay',
                finished_at = null, updated_at = now()
          where id = $1::uuid and status = 'dead'`,
        [id]
      );
      if (r.rowCount === 1) return "replayed";
      const exists = await tx.query("select 1 from jobs where id = $1::uuid", [id]);
      return exists.rowCount === 1 ? "not_dead" : "not_found";
    });
  }

  async discard(id: string): Promise<DiscardOutcome> {
    if (!UUID.test(id)) return "not_found";
    return withOwnerTx("operator", async (tx) => {
      const r = await tx.query(
        "delete from jobs where id = $1::uuid and status = 'dead'",
        [id]
      );
      if (r.rowCount === 1) return "discarded";
      const exists = await tx.query("select 1 from jobs where id = $1::uuid", [id]);
      return exists.rowCount === 1 ? "not_dead" : "not_found";
    });
  }

  async prune(before: Date, limit: number): Promise<number> {
    const { rowCount } = await withOwnerTx("platform-job", (tx) =>
      tx.query(
        `delete from jobs
          where id in (select id from jobs
                        where status = 'succeeded' and finished_at < $1::timestamptz
                        order by finished_at
                        limit $2::int)`,
        [before.toISOString(), limit]
      )
    );
    return rowCount;
  }

  async activeTenantIds(): Promise<string[]> {
    const { rows } = await withOwnerTx("job-claim", (tx) =>
      tx.query<{ id: string }>(
        "select id from tenants where status = 'active' order by id"
      )
    );
    return rows.map((r) => r.id);
  }
}
