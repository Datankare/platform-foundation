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
