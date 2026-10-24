# ADR-056: Operations Baseline — Recovery, Background Work, Health, Alerting and Objectives

Status: Proposed (Phase 5 Sprint 7R entry gate, 2026-10-21). Decision maker: Raman Sud.
Related: ADR-014 (observability), ADR-041 (escalation SLA), ADR-048 (governed budgets), ADR-053 (tenancy), ADR-055 (deploy anywhere), TASK-129, TASK-141, TASK-142, TASK-143. `platform/observability/**`, `platform/jobs/**`, `docs/runbooks/**`.

---

## 1. Context

A mission-critical claim needs an operations layer the platform does not have. A survey of the code in October 2026 found:

- **Timed work has no trigger** (TASK-141). The escalation-SLA reaper (ADR-041) is a route nothing calls; overdue review claims and expired strikes have functions with no caller; the GDPR retention purge is manual; the analyst and curator agents have budgets but no schedule. There is no queue, outbox or dead-letter handling; retries happen inside a request only.
- **Health probes only song identification** (TASK-142): the database, cache and realtime probes exist but are not registered, and there is no readiness check.
- **No recovery design:** recovery relies on the database plan's defaults; there is no RPO, RTO or restore drill.
- **Observability stops at the process:** structured logs to stdout, optional Sentry, trace ids without an exporter, metrics written to a table that no migration creates (TASK-113); no alerting, objectives or incident runbooks.
- **The scheduled load test targets a server it never starts** and cannot pass (TASK-143).

## 2. Decisions

**D1 — Recovery targets.** Production: **RPO ≤ 5 minutes** through point-in-time recovery (Supabase PITR; RDS automated backups on AWS); **RTO ≤ 1 hour** to a restored, serving deployment. A restore drill — restore to a new database, run the migration-replay checks and the smoke test against it — runs every quarter and after any change to the schema baseline, and its result is recorded.

**D2 — Background work is durable and host-neutral.** A Postgres-backed job queue (`platform/jobs`): jobs are rows, claimed with `FOR UPDATE SKIP LOCKED` by a narrow claim function — the one cross-tenant step, running with owner rights and closed to `anon` and `authenticated` (TASK-137's replay check) — then each job runs inside its tenant's context through the data layer (ADR-053 D4), retried with backoff, idempotent by key, and moved to a dead-letter state after their last attempt, where an operator sees and replays them. A scheduler records recurring jobs and enqueues them when due. The host only provides a tick: Vercel Cron on Vercel, EventBridge Scheduler on AWS, each calling one signed internal route that runs due work for a bounded time. In 7R, before the data layer exists (7T), jobs reach Postgres through the claim function and the existing stores; they move onto `platform/data` with the rest in 7T.

**D3 — Every timed duty is a registered job.** The escalation reaper, review-claim release, strike expiry, the GDPR retention purge and scheduled agents become recurring jobs; a CI check fails when a function documented as scheduled has no registered job.

**D4 — Health tells the truth.** Liveness (the process answers) and readiness (boot completed; the database and a selected shared cache answer) are separate (ADR-055 D5); realtime and module probes report degraded without making an instance unready, so one dependency blip cannot take every instance out at once. The deploy smoke test checks readiness.

**D5 — Telemetry leaves the process.** Traces and metrics are exported through OpenTelemetry (OTLP) to a configurable backend; logs are structured JSON with request, tenant and trace ids; errors go to the error reporter. Each is a provider slot with a no-op default.

**D6 — Objectives and alerts.** Initial service-level objectives, per tenant and overall: availability 99.9% monthly for non-AI API routes; p95 latency under 500 ms for non-AI routes and under 3 s to first streamed token; job success 99% with no job older than its schedule plus one interval. Alerts page on fast error-budget burn, readiness failures, dead-lettered jobs, AI budget exhaustion and rate-limit store failure (ADR-052 D4).

**D7 — Runbooks.** `docs/runbooks/` holds one runbook per alert and per recovery step (restore, failover between hosts, credential rotation, tenant suspension), each tested at least once.

## 3. Delivery

- **Sprint 7R:** this decision; health probes registered and the readiness check (TASK-142); the scheduled load test fixed (TASK-143); the job queue and scheduler, with every timed duty registered (TASK-141) — timed duties that already exist must run, not wait for 7O.
- **Sprint 7O:** point-in-time recovery confirmed on both hosts with a tested restore drill, the OpenTelemetry exporters, objectives and alerting live on both hosts, runbooks, per-environment keys (TASK-124), and dynamic testing and compliance mapping (TASK-130).

## 4. Consequences

- A function that must run on a schedule is a registered job; nothing relies on a person or an external caller remembering.
- Every alert has a runbook, and every recovery claim has a drill behind it.

## 5. Implementation (7R R5)

Delivered on `develop` (2026-10-24): D2, D3 and D4. D1, D5, D6 and D7 remain Sprint 7O.

**The queue (D2).** Migration 050. `jobs` holds one row per unit of work: a tenant's job carries
its `tenant_id` and is isolated like every tenant table (forced row-level security, the
`tenant_isolation` policy); a platform job has `tenant_id` null and is reachable only on the owner
connection. Idempotent: `(tenant_id, kind, idempotency_key)` is unique with nulls not distinct, so
a repeat enqueue is the same job and the same key in another tenant is another job. `status` is
`queued` → `running` → `succeeded`, or back to `queued` with a later `run_at` (a retry), or `dead`
after the last attempt, or `parked` while its tenant is not active (§6). `app_tenant` may read its
tenant's jobs and insert, change or remove none (§6: every enqueue goes through `platform/jobs` on
the owner connection). `job_claim(worker, kinds,
limit, lease_seconds)` is the one cross-tenant step: owner rights (`SECURITY DEFINER`, empty
`search_path`), bounded inputs, `FOR UPDATE SKIP LOCKED`, a lease per job (`locked_until`,
`lease_token`); only the kinds the calling worker can run, only jobs a tenant may run now (§6); a lapsed
lease makes a job due again, and one that lapsed on its last attempt is dead. It is closed to
`public`, `anon`, `authenticated` and `app_tenant` and granted to `service_role`; the migration
replay checks that (TASK-137 class), runs four claimers at once over forty jobs (each taken
exactly once), recovers a lapsed lease, dead-letters a lapsed last attempt, checks per-tenant keys
and the request role's reach, and applies 050 and 051 a second time against a snapshot.

`platform/jobs`: the store is a provider slot (`JOB_STORE`: `postgres`/`supabase` →
`PostgresJobStore`, `memory` → `InMemoryJobStore`, refused in production unless the harness opts
out); both pass one conformance kit (`__tests__/contract/job-store-contract.ts`). Kinds are an
extensible registry — the core's duties (`duties.ts`), each registered module's `jobs`
(`PlatformModuleInput.jobs`, named `<module>.…`), then the app's (`registerJob`) — composed and
validated at boot, a second declaration of a kind refused naming both owners. `enqueueJob` is
idempotent by key and bound to the caller's tenant and the kind's scope (§6). `runDue({ budgetMs
})` takes due schedule slots, then claims a batch — only kinds whose attempt timeout fits in what
is left of the budget, and only as many as fit end to end, so no attempt runs past the tick — runs
each inside its tenant
(`runWithTenant`; every store and `withTenantTx` it reaches is that tenant's), a platform job from
the platform's home tenant (the single tenant, or the default tenant operators act from) so its
audit records sit with operators', and settles it by its lease token. A failure — any thrown value
— or a timeout is retried after exponential backoff with equal jitter (default 1 min doubling to 1
h) and dead-lettered after `maxAttempts` (default 5); `last_error` is the platform's own wording
(`errors.ts`: a `JobFailure`'s message, else a category — never a database's or a dependency's
text), the detail goes to the log and the error reporter. A handler whose batch is full returns
`continueWith` and the next part is enqueued once (`continue:<job id>`). Delivery is at least once,
so every handler is idempotent.

**The tick.** `/api/internal/jobs/tick` (GET for Vercel Cron, POST for the CLI), verified by
`requireJobTick`: `Authorization: Bearer $CRON_SECRET`, SHA-256 digests compared with
`timingSafeEqual`; an unset or short (< 32 characters) secret refuses every tick (503) in every
environment. Declared in the route policy as the platform's one secret-verified route and exempt
from the limiter (the secret is checked first; the work is bounded by its 45-second budget inside
`maxDuration = 60`). `vercel.json` ticks every five minutes. **Vercel plan limit:** Hobby allows
cron jobs at most once a day and rejects a more frequent expression at deployment; every five
minutes needs Pro (Datankare's team is on Pro). On Hobby, or any host without a scheduler, run
`npm run jobs:worker` (`scripts/jobs-worker.mjs`) beside the app: it calls the same route with the
same secret every `JOBS_WORKER_INTERVAL_SECONDS` (default 60), at once again while work remains,
and stops on a refused secret; R6's container image runs it.

**Every timed duty is a job (D3).** Recurring, with governed settings seeded by 050:
`moderation.escalation-reaper` (15 min, 5–60), `moderation.release-claims` (15, 5–120),
`moderation.expire-strikes` (60, 15–1440), `accounts.expire-restrictions` (60, 15–1440: a lapsed
restriction or suspension steps down to warned, as the guard's gotcha asked), `gdpr.retention-purge`
(1440, 60–1440), `agents.trajectory-retention` (1440, 60–10080: enforces
`agent.trajectory.retention_days`), each for every active tenant; `config.expire-approvals` (60,
15–1440: TASK-036), `tenancy.purge-due` (60, 15–1440) and `jobs.prune` (1440, 60–10080, keeps
succeeded jobs `jobs.retention_days`, dead ones until an operator acts) for the platform. The
social module adds `social.analyst` and `social.curator` (1440, 60–10080, migration 051): each walks
the tenant's groups a page at a time through `executeAgent`, so the agents' governed budgets bind
(a budget pause ends the run for that slot), and a tenant's administrators may turn both off
(`social.scheduled_agents_enabled`, tenant settable). Their output is the agent trajectory (the
report, the digest); delivery to members waits for TASK-108. The uncalled
`/api/admin/moderation/reap-escalations` route is removed: nothing relies on an external caller,
and an operator runs any duty at once from the Jobs console. The sweeps that used to report 0 on a
database failure (`expireStrikes`, `releaseExpiredClaims`) now throw, so their job retries.

Each enabled flag and interval is configuration (`jobs.<kind>.enabled`,
`jobs.<kind>.interval_minutes`, safety tier, platform-only), so a change is tier-checked, audited,
kept in history and — turning off the escalation reaper, the GDPR purge or the tenant purge — held
for a second operator (`config.dual_control_keys`). `job_schedules` keeps only runtime state (next
slot, last run, last outcome). `__tests__/jobs-scheduled-coverage.test.ts` fails when a function
tagged `@scheduled <kind>` names no registered job, when a registered job has no schedule (an
on-demand kind must be listed with its reason), when a recurring job has no tagged function, when
its settings are not seeded with its own defaults and bounds, and when a comment describes a "cron
job", a "scheduled job" or something run "on a schedule" without the tag.

**Operators.** The Jobs console (`components/admin/JobsPanels.tsx`, the "Jobs (operators)" section,
`platform_operate`): every recurring job with its owner, scope, setting, bounds, last run, last
outcome and queue counts — turn it on or off and change its interval (a reason asked inline,
answered 200 applied or 202 held), run it now (enqueued for every active tenant or the platform,
what fits in 45 s run in the request); the dead letters with their recorded reason — replay (from
the first attempt; a second replay is `jobs.not_dead`) or discard (confirmed first). Routes
`/api/operator/jobs`, `/api/operator/jobs/schedules/[kind]` (PATCH),
`/api/operator/jobs/schedules/[kind]/run`, `/api/operator/jobs/dead/[id]`; every action audited
before it takes effect; new codes `jobs.not_found`, `jobs.not_dead`. A tenant's administrators see
their tenant's 25 most recent jobs, read-only, on the Tenant page (`GET /api/admin/tenant` →
`jobs`). Runbook: [docs/runbooks/jobs.md](../runbooks/jobs.md).

**Health (D4, TASK-142).** `/api/health/live` asks nothing. `/api/health/ready` is 200 when boot
completed (`instrumentation.ts` records each step in `platform/observability/boot.ts`, so a failed
boot is reported with its step) and every required probe answers — the database when the
deployment has one (`PostgresHealthProbe`) and the selected cache (`createCacheReadinessProbe`);
"degraded" (still 200) when an optional probe fails — realtime (`createRealtimeServiceProbe`: the
selected service answers at all) and the modules' probes; 503 otherwise. `HealthRegistry` marks
each probe required or optional; probes are bounded (3 s for readiness) and run in parallel; answers
carry names and statuses only. `/api/health` keeps its shape and status codes, now with `required`
on each check and `ready` and `boot`; an unhealthy optional probe makes it degraded (200) rather
than unhealthy. `scripts/deploy-smoke.mjs` checks liveness, then readiness (and the commit).
Consumer seam: Playform keeps its own `instrumentation.ts`, which must record the boot steps and
register the probes the same way to report readiness.

**TASK-143.** `load-test.yml`: a run whose target is the runner (the schedule, or a manual run left
at its default) builds the app, starts it on the E2E harness and waits for `/api/health/ready`
before k6; a manual run against an `https://` address tests it directly; any other input is refused
(and reaches the shell as an environment variable, never as workflow text). The monkey run waits
for readiness too.

**Deploy prerequisites.** Apply 050 (and 051 with the social module) before deploying; set
`JOB_STORE=postgres` and `CRON_SECRET` (32+ random characters) in every deployment — boot refuses
a deployment without the secret (§6), since its tick would refuse every call and no duty would run.

## 6. The R4–R6 review (before release)

An adversarial review of the unreleased R4–R6 commits found sixteen defects, each proved by a test
that now asserts the fix (`__tests__/jobs-hostile.test.ts` and the other tests named in TASK-156).
What changed in the design:

**Stopping without failing requests (finding 1; ADR-055 D5).** Every API route handler is counted
in flight while it runs (`platform/observability/in-flight.ts`, through `tenantRoute`). On SIGTERM
the stop flips readiness (503, unchanged), drains, then waits for the count to reach zero — up to
the stop deadline, the bound less a reserve of at most 2 s for the steps — before it flushes
telemetry and closes the cache and the pools; something still running at the deadline is logged and
makes the exit 1. The stop deadline is given to the job runner with the draining flag: the runner
takes no schedule slot and claims nothing more, hands back the claimed jobs it has not started
(`release`: queued again, the attempt not counted), and aborts the running attempt's signal. A
cooperative handler ends at its next item: completed (with its continuation) if it returns,
handed back if it throws. The runner never waits for an attempt past the stop deadline, so a tick
in flight — whatever its 45-second budget — answers inside the bound and the pools close after
it. The CLI worker stops at once on SIGTERM (the app finishes the tick it began), so the worker's
container stops inside Docker's 10-second grace. Hosts: keep `SHUTDOWN_TIMEOUT_SECONDS` inside the
grace period (`docker stop -t`, ECS `stopTimeout`, Kubernetes `terminationGracePeriodSeconds`).

**The tick's secret and stale schedules (finding 2).** `CRON_SECRET` is required by the
environment contract on every deployment host (not `local` or `ci`): Vercel Cron and the
container's worker call the same route, and without it nothing runs. An optional probe,
`job-schedules` (`platform/jobs/schedule-probe.ts`), makes readiness and `/api/health` degraded —
never unready — when an enabled recurring kind has not run for twice its interval (at least 15
minutes), or has never run 15 minutes after boot or after it was turned on; its detail names the
kinds (log and error reporter only).

**A handler past its time (finding 3).** The duties that work item by item — the escalation reaper,
lapsed restrictions, the GDPR purge, the tenant purge, the social agents — check `ctx.signal`
between items and continue in a next part when told to stop. A handler still running past its
timeout (waited for 5 s in the tick) is never settled while it runs, since settling would queue
its retry beside it: its lease is extended every 10 s while it runs, for at most 15 minutes
(`MAX_HUNG_MS`, then let go and reported), and it is settled as timed out when it settles. It is
counted in flight, so a stopping instance waits for it to its bound.

**Enqueue is bound (finding 4).** A kind declares its scope (`scope`, or its schedule's).
`enqueueJob` refuses an unregistered kind, a platform kind for a tenant, a per-tenant kind as a
platform job, and any tenant but the current one — unless the caller presents a `JobAuthority`
(`platform/jobs/authority.ts`): an object only that module mints, held by the runner (claimed once,
given to platform jobs' handlers as `ctx.authority`) and by verified operators
(`operatorJobAuthority`, `platform_operate`); a forged one is refused. `app_tenant` has no insert
on `jobs` at all: no request path needed it, and with it removed an injection reaching the request
role cannot queue, backdate or misname work.

**The claim (findings 5, 6, 7).** A non-active tenant's queued jobs are parked (`status = 'parked'`)
by a trigger on `tenants`, and a job written queued for such a tenant is parked as it is written;
resuming the tenant queues them again. `jobs_queued_idx (tenant_id, kind, run_at, id) where status
= 'queued'` holds only runnable work. `job_claim` serialises claims with a transaction-scoped
advisory lock, dead-letters lapsed last attempts, takes lapsed leases first, then queued jobs
tenant by tenant in turn (round-robin over the tenants with queued work, found by skipping through
the index; a range scan per tenant and kind bounded by the claim's limit). Measured on Postgres 16
with 300 000 due jobs of a suspended tenant, 300 000 of one busy tenant and 300 000 of a kind no
worker runs: 7.3 ms for a session's first claim, 2.2 ms after; another tenant's one job, enqueued
last, is in the first batch (it was 423 ms at 300 000 rows). The runner claims batches of up to 10.
`run_at` in the past is clamped to now (`enqueueJob` and the database's `jobs_on_write` trigger).
`runsForSuspended` (the GDPR retention purge, trajectory retention — legal obligations) keeps a
kind's jobs claimable, and its schedule reaching, suspended tenants; a deleted tenant's never.

**Truthful outcomes (finding 8).** `job_schedule_outcomes` keeps each tenant's (or the platform's)
latest outcome per kind; the console shows the worst ("Last job was dead-lettered (failing for 1
of 40 tenants)") and its error.

**Smaller fixes (9–16).** 050 adds the safety duties to `config.dual_control_keys` on its first
application only, so an operator's removal stands (the replay applies it a second and third time).
`load-test.yml`'s target is checked whole by `scripts/load-test-target.sh` (newlines refused).
CI pulls the base image by digest (`scripts/pull-base-image.sh`: the digest from Docker Hub, the
same digest from the mirror, `ARG BASE_IMAGE_DIGEST` mandatory to match when pinned). A module's
jobs are part of its fingerprint. Boot refuses a kind whose timeout cannot fit in a tick
(`checkJobsFitTick`). "Run now" is one `insert … select` fan-out with a second audit record of
what happened. A schedule is due at `least(next_run_at, last_run_at + interval now)`, so a
shortened interval applies at the next tick however it was approved. The health routes share one
probe run per 3 s (single flight) and report a probe's problem when its state changes.
