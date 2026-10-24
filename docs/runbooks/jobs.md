# Runbook — background jobs (ADR-056 D2, D3)

The platform's timed duties and background work run as jobs: rows in `jobs` (migration 050),
claimed by `job_claim`, run in their tenant by `platform/jobs`, triggered by the host's tick
(`/api/internal/jobs/tick` — Vercel Cron every five minutes, or `npm run jobs:worker` on a host
without a scheduler). Operators act through the **Jobs (operators)** section of the admin console;
every action there is audited. This runbook covers what to do when something is wrong.

| Symptom                               | Section                                             |
| ------------------------------------- | --------------------------------------------------- |
| A job is in the dead letters          | [1. Dead letters](#1-dead-letters)                  |
| Jobs stay queued or running           | [2. Stuck jobs](#2-stuck-jobs)                      |
| A duty must stop for a while          | [3. Pausing a schedule](#3-pausing-a-schedule)      |
| No job runs at all                    | [4. Nothing runs](#4-nothing-runs)                  |
| A tenant asks why its digests stopped | [5. A tenant's own switch](#5-a-tenants-own-switch) |

Read-only SQL below runs on the owner connection (the Supabase SQL editor, or `psql
"$DATABASE_OWNER_URL"`). Changes are made through the console, never by hand, so they are audited.

## 1. Dead letters

A job is dead when it failed on every attempt (default 5, with backoff from one minute doubling to
an hour), or when its worker stopped during its last attempt. The console lists each with the
platform's own wording of why — never a database message; the full error is in the server log
(`Jobs: dead-lettered after its last attempt`, with `jobId`) and the error reporter.

1. Read the reason in the console (**Dead letters**). Match it in the log by `jobId`.
2. Fix the cause first. Typical: `The database was unavailable.` (an outage — nothing to fix once
   it is over); `A database statement failed (SQLSTATE …)` (a schema or data problem — look the
   SQLSTATE up and read the log line); `N of M due erasures did not complete` (the GDPR purge: an
   account's data could not be removed — see the log's `gdpr_purge_executed` audit records for the
   failing module); `The job did not finish within its time` (the work was too large for one
   attempt, or a dependency hung).
3. **Replay** runs it again from its first attempt. A second replay of the same job answers
   `jobs.not_dead`: it is already queued.
4. **Discard** removes it for good (asked to confirm). Use it only for work that no longer matters
   — a recurring duty's next run does the same work anyway.

Every dead letter of a recurring job also shows on its schedule row ("Last job was
dead-lettered"). Several dead letters of one kind across tenants usually mean one cause.

## 2. Stuck jobs

A **running** job holds a lease: its kind's time limit plus 30 seconds. If its worker dies (an
instance recycled mid-tick), the lease lapses and the next tick takes the job again (its attempt
counts); a job whose lease lapsed on its last attempt is dead-lettered. Nothing needs doing for a
running job unless its lease is long past:

```sql
select id, kind, tenant_id, attempts, max_attempts, locked_by, locked_until
  from jobs
 where status = 'running' and locked_until < now() - interval '10 minutes'
 order by locked_until;
```

Rows here mean no tick has run since the lease lapsed — see [4. Nothing runs](#4-nothing-runs).

A job can also stay **running** past its time limit because its handler is still running (it
ignored its stop signal). The runner does not retry it while it runs — that would run two copies —
but keeps its lease, extended every 10 seconds, for up to 15 minutes, and settles it as timed out
when it stops. The log says `Jobs: a handler is still running past its time; its lease is kept`;
after 15 minutes `… its lease is let go` (also sent to the error reporter): the job can then be
taken again, and the handler is a defect to fix.

A **queued** job runs when its `run_at` has passed and a tick claims it; tenants are served in
turn, so one tenant's backlog does not hold up another's jobs. A **suspended** tenant's jobs are
**parked** until it is resumed (then queued again at once), except the legal obligations — the
GDPR retention purge and trajectory retention — which keep running for it. A deleted tenant's jobs
stay parked and are removed by its purge. To see what is waiting and why:

```sql
select j.kind, j.status, t.status as tenant_status, count(*) as jobs, min(j.run_at) as oldest_due
  from jobs j left join tenants t on t.id = j.tenant_id
 where j.status in ('queued', 'parked')
 group by j.kind, j.status, t.status
 order by oldest_due;
```

A large `oldest_due` lag with an active tenant means the ticks cannot keep up: each tick runs for at
most 45 seconds. Run the CLI worker beside the app as well (`npm run jobs:worker`), or lower the
volume (a longer interval for the busiest kind).

## 3. Pausing a schedule

In the console, **Turn off** on the job's row (a reason is asked). It is a governed change of
`jobs.<kind>.enabled` (safety tier): recorded in the audit log and the config history, and subject
to the same approval rules as any safety setting — when two-person approval is on, it waits for a
second operator ("held"). Turning off the escalation reaper, the GDPR retention purge or the tenant
purge is always held for a second operator (dual control): they enforce the escalation SLA
(ADR-041), erasure and tenant deletion. Jobs already queued still run; turning a schedule off stops new slots. **Turn on** resumes
it; its next slot is due at once.

To run less often instead, set the interval (within its bounds, shown on the row). A shorter
interval applies at the next tick (`Next:` moves forward); a longer one after the next slot. To
run now — after a fix, or to check one — **Run now** enqueues it for every tenant it runs for (or
the platform) in one step and runs what fits in 45 seconds; the rest runs on the next tick. Its
schedule is not moved. The audit log holds two records: the attempt, and what happened (enqueued,
claimed, succeeded, retried, dead).

A recurring job's row shows the worst latest outcome across its tenants — "Last job was
dead-lettered (failing for 2 of 40 tenants)" — so one tenant's success never hides another's
failure.

## 4. Nothing runs

1. `GET /api/health/ready` must be 200: a failed boot or an unreachable database stops the runner.
   `"status": "degraded"` with the `job-schedules` check degraded means schedules are late: the
   server log's `Health probe degraded` line (probe `job-schedules`) names each kind and when it
   last ran — usually no tick is arriving (step 2).
2. The tick must be called and admitted. A deployment without `CRON_SECRET` does not boot (the
   environment contract names it). In the Vercel project: **Settings → Cron Jobs** lists
   `/api/internal/jobs/tick` every five minutes (Pro plan; Hobby allows once a day — use the CLI
   worker). Its log shows `Jobs: tick` every run; `Job tick refused: CRON_SECRET is not set` means
   the secret is missing (set `CRON_SECRET`, 32+ random characters: `openssl rand -hex 32`, then
   redeploy); a 401 means the caller's secret differs.
3. `JOB_STORE` must be `postgres` (the boot refuses `memory` in production).
4. The schedule must be on (**Jobs** shows On) and its slot due (`Next:` on the row).

## 5. A tenant's own switch

A tenant's administrators may turn the scheduled social agents (analyst, curator) off for their
tenant: the setting `social.scheduled_agents_enabled` on their **Tenant** page. Their jobs then
succeed without running the agent. Operators see the setting on the tenant's settings (Tenants →
Settings), and the tenant's administrators see their own recent jobs, read-only, on the Tenant page.
