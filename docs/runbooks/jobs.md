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

## 6. Erasures that do not complete (TASK-193)

gdpr.retention-purge no longer fails its attempt when an erasure fails: each failure is deferred
(`user_deletions.purge_attempts`, `purge_retry_at`: 1 h, doubling, at most 7 days;
`last_purge_error` names the failing steps), so the others go on. Alerts:

- `gdpr.erasure_stuck` — an erasure has failed 5 or more times. Read `last_purge_error`; fix the
  step (an app's deletion module, the database); it is retried on its own.
- `gdpr.external_erasure_pending` — a store outside the database (the identity provider) refused
  3 or more times: check the Cognito IAM key holds `cognito-idp:AdminDeleteUser`
  (TENANCY_OPERATIONS §3.3). Until it is done the erasure is not marked purged.
- `gdpr.erasure_unrecorded` — accounts marked deleted had no erasure record; each is now recorded
  and purged on schedule. Find what deleted them outside `softDeleteUser`.
- `gdpr.identity_pool_unverified` — the identity was not found, but in a pool not shown to be the
  account's: the identity was never proven present in the current pool (an old-pool account never
  re-linked, an erasure from before migration 060, a reconciled one), the erasure recorded another
  pool, or DescribeUserPool did not confirm the pool. It stays pending. If the identity is in an
  older pool, delete it there; then — or if the pool is gone, or the account never had an
  identity — two operators attest it (TENANCY_OPERATIONS §4, "Closing an erasure the system
  cannot verify"). That is the only way to close it; never mark it done by hand.

Each cause alerts once per run: an erasure held only by its identity step is the identity alert,
not `gdpr.erasure_stuck` as well.

The consent expiry (a child's account whose consent is pending or denied past
`coppa.consent_expiry_days`) runs only while `coppa.consent_expiry_enabled` is on — off until the
parental-consent flow ships. Before turning it on, count what it would erase:
`select count(*) from users where parental_consent_status in ('pending', 'denied') and deleted_at is null and coalesce(age_verified_at, created_at) < now() - interval '14 days';`

Check: `select count(*) filter (where purged_at is null and purge_after <= now()) as due, count(*) filter (where purge_attempts >= 5) as stuck, count(*) filter (where external_erasures -> 'identity-provider' ->> 'doneAt' is null) as identity_pending from user_deletions;`

## 7. The JSON bound and the erasure's functions (TASK-229, ADR-058)

### json-bound degraded

`/api/health` shows the probe `json-bound` degraded, and the deploy smoke fails, whenever the bound
on stored JSON is not in force; its detail names each line. Read them in the SQL Editor:
`select m from public.json_bound_missing() m;` — then, by what it says:

- `public.<table>: trigger … missing / not as migration 074 makes it` — repair that table:
  `select public.json_bound_install(array['public.<table>'::regclass]);` then
  `select public.json_bound_check('public.<table>');`. A line that reads
  `public.<table> (its partition public.<part>): …` is repaired through the table before the
  brackets (the partition's triggers are its clones; `json_bound_install` refuses a partition's
  own name).
- `… not enabled ALWAYS (the bound is off)` — someone ran `json_bound_off`; put it back as above
  when the reason for the switch is gone.
- `… existing rows not checked against the bound` — `select public.json_bound_check('public.<table>');`
  (rows it names: `select public.json_bound_convert('public.<table>');`, then the check again —
  docs/MIGRATION_v5_to_v6.md, "A row over the JSON bound"). Also what a table reads after a
  partition was attached to it, and what every table reads after a restore (below).
- `… service_role holds TRIGGER on it and could replace the bound's triggers` (or `anon`,
  `authenticated`) — an older migration applied again, or a grant by hand, gave the privilege
  back: `select public.json_bound_install(array['public.<table>'::regclass]);` takes it away (it
  re-makes no trigger and no row needs reading again).
- `… fires after the bound`, `… rewrite rule …`, `… holds JSON the bound cannot check` — a change
  outside the platform's migrations went round the bound: undo it, or make the column `jsonb`.
- `public.json_bound_…(): not as migration 074 makes it`, `… executable by anon` — one of the
  nine functions that decide a refusal or what is installed (`json_bound_refuse`, `_reason`,
  `_depth_path`, `_number_path`, `_limit`, `_term`, `_ddl`, `_tables`, `_mark`), or a grant, was
  changed: restore it (re-applying 074 is refused after 075; restore by hand to 074's text, or
  ask before changing it). A later migration that replaces one of them on purpose re-makes
  `json_bound_missing` with its own fingerprints. (076 replaces none: `json_bound_limit`'s one
  exception names the column 076 drops, so it is left as 074 made it — ADR-059.)
- `07x_….sql: not recorded` — apply 074 and 075 (docs/MIGRATION_v5_to_v6.md).

Check: `select count(*) from public.json_bound_missing();` answers `0`.

### After a restore or an upgrade

- **A restore, a Supabase branch, a copy made with dump and restore:** every trigger row has a
  new catalogue version, so every covered table reads "existing rows not checked" and the deploy
  smoke fails. Run `select public.json_bound_check();` (as `postgres`; it reads every row once).
- **A major PostgreSQL version** may print a function's definition differently: then readiness
  names the nine functions ("not as migration 074 makes it") and — more seriously —
  `public.erasure_functions_missing()` names the two rewrites, so **every erasure is refused**
  (alert `gdpr.erasure_schema_missing`) until they are made again. Before upgrading a database,
  try it on a copy and run both checks above; if they name functions, the upgrade needs a
  migration that re-makes 074's functions and readiness on the new version — do not edit them by
  hand. Not tried here: only PostgreSQL 17.6 has run this code.

### Erasure refused: functions missing

Alert `gdpr.erasure_schema_missing` (at most once per ten minutes per process): the soft delete,
the purge or the cross-tenant pass refused because `jsonb_erase_id_text` or
`jsonb_erase_address_text` is missing or not as migration 074 made it (definition, owner or
grants). Nothing was written and no purge attempt was counted: every erasure stays due. Read
`select m from public.erasure_functions_missing() m;` — `…: missing` means 074 is not applied
(apply it); `… not as migration 074 makes it` means the function was changed (restore it). The
next run proceeds on its own.

### Erasures refused

While that is so, each run of the job `gdpr.retention-purge` **fails** with "Erasures were not
run: the database's erasure functions are not as migration 074 makes them …" (its other parts —
reconciliation, consent expiry, external stores — have run): the Jobs console shows the failed
runs and, after its attempts, a dead letter. Fix the functions as above; the next scheduled run
succeeds, and a dead-lettered run needs nothing (the schedule enqueues the next).

Check: `select count(*) from public.erasure_functions_missing();` answers `0`.

### An erasure refused by the bound (a row stored before it)

A purge or soft delete failed with `23514` and constraint `json_bound` ("a JSON value over the
bound is refused"): the erasure had to update a row that was stored before migration 074 (or
while the bound was off) and holds a value over it — a number outside 1e-18…1e21, most likely.
The erasure is deferred and retried (`last_purge_error`, then `gdpr.erasure_stuck` after 5); it
cannot complete until the row is converted. As `postgres`:
`select public.json_bound_convert();` (nothing is deleted: docs/MIGRATION_v5_to_v6.md, "A row over
the JSON bound"), then `select public.json_bound_check();`. The erasure completes at its next
retry. Check: `select count(*) from public.json_bound_missing();` answers `0`, and the account's
`user_deletions.purged_at` is set after the next run.

### An erasure refused a key collision

A purge or soft delete failed with `erasure: replacing an account id (an address) would merge two
keys of one object even when numbered` (data_exception). Never seen in the fuzz: one document holds
keys that, with the id or address replaced, would still collide after numbering. The purge is
deferred (`last_purge_error`, then `gdpr.erasure_stuck` after 5). Find the row:
`select ctid from public.<table> where <column>::text ~* '<id>';` (as postgres), read it, and edit
that one document by hand so its keys differ, then let the purge run again.

### A receipt, a classifier output, a step or a metric was not kept

Five counters (each logged at warn, with the refusal's code — never the value):

| Counter                            | What happened                                                                                                                                                                                                   | What a reader gets                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect.receipt_not_kept`          | An effect's receipt could not be kept: over 6 MiB as printed (an image over about 4.4 MiB), nested over 64 levels, a number outside 1e-18…1e21, or a text jsonb refuses. Stored as `{"_omitted": {"code": …}}`. | The effect happened. A generation that needed approval is `withheld`, saying the largest image a held generation keeps.                                                                                         |
| `effect.receipt_not_kept_replayed` | Such an effect was asked for again with the same operation id.                                                                                                                                                  | `resultKept: false` (image generation: "The earlier image is no longer available; generate it again."); nothing is fired again.                                                                                 |
| `moderation.output_not_kept`       | A classifier's output — or another field of a moderation result, named in the counter's `column` — was over the stored-JSON limits.                                                                             | The decision stands with its own fields; the record carries `classifierOutputNotKept` / `fieldsNotKept`. The review screen shows the decision without the classifier's detail (no screen words the reason yet). |
| `trajectory.step_not_recorded`     | A run's step, an action's result or a compensation's result (the counter's `field`: input, output, step, cost, action) could not be stored after the work.                                                      | The run or action went on; the step holds `inputNotRecorded` / `outputNotRecorded` / `costNotRecorded` with the code.                                                                                           |
| `metrics.dropped_over_bound`       | One metric event's name, values or tags could not be stored.                                                                                                                                                    | That event alone is dropped; the rest of its batch is written.                                                                                                                                                  |

Nothing to repair. If one recurs, a provider or a tool is returning values outside the limits (a
number below 1e-18 or at 1e21 and above — often the residue of arithmetic on small amounts, which
a writer rounds before storing; more than 1 MiB; a text cut inside an emoji): look at which one.
Check: `select count(*) from public.effect_ledger where receipt ? '_omitted';`.
