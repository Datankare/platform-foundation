# ADR-014: Observability Architecture

## Status: Accepted

## Date: 2026-04-03

## Context

During the Phase 1 review, an honest audit revealed that observability was identified as Tier 1 fabric but only partially built. The structured logger (`lib/logger.ts`) exists with request IDs, but logs go to Vercel function stdout and disappear when functions recycle. No error aggregation, no distributed tracing, no alerting, no AI cost tracking.

The principle was established early: **observability is fabric, not a nice-to-have.** It must be woven in, not bolted on after launch.

## Decision

Observability is a cross-phase fabric delivered incrementally:

### Components

| Component                    | Purpose                                                                        | Phase |
| ---------------------------- | ------------------------------------------------------------------------------ | ----- |
| Error Tracking (Sentry)      | Real-time error aggregation — every error surfaced, none silently swallowed    | 2     |
| Log Aggregation              | Centralized, searchable logs across all services                               | 2     |
| Distributed Tracing          | Trace a request end-to-end across voice → safety → translate → TTS pipeline    | 2     |
| AI Call Instrumentation      | Per-call: model, tokens in/out, latency, cost, cached vs fresh                 | 2     |
| APM Dashboards (Datadog)     | Know before users tell you something is slow or broken                         | 3     |
| Voice Pipeline Tracing       | Multi-API chain observability for the most complex pipeline                    | 3     |
| SLA Definition               | Committed uptime (99.9%? 99.95%?) — shapes infrastructure and architecture     | 3     |
| Content Safety Audit Trail   | Every moderation decision: classifier output, confidence, action, user rating  | 4     |
| AI Quality Monitoring        | Hallucination detection, user satisfaction signals, response quality over time | 7     |
| User-Level Cost Attribution  | Token cost per user, per feature, per app                                      | 7     |
| Analytics Dashboards         | Business intelligence: engagement, retention, revenue per feature              | 7     |
| Alerting & Incident Response | Who gets paged at 2am? Runbooks for all operational scenarios                  | 9     |
| Chaos Engineering            | Deliberately break things in staging to find weaknesses                        | 9     |
| Uptime SLA Enforcement       | Monitoring against committed SLA, automated alerting on breach                 | 9     |

### Current State (Phase 1 baseline)

| What Exists                                          | Limitation                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `lib/logger.ts` — structured logger with request IDs | Writes to stdout only. Logs disappear on function recycle.       |
| `generateRequestId()` per request                    | No trace propagation across external API calls                   |
| `logger.error()` on API failures                     | No aggregation, no alerting, no dashboard                        |
| `fetchWithTimeout` with retry                        | Only resilience mechanism. No observability into retry behavior. |
| `audit_log` table (immutable)                        | Safety pass/fail logged. Classifier output NOT logged.           |

### Target Architecture

```
Every request:
  → Request ID generated (exists)
  → Trace context propagated to all downstream calls (Phase 2)
  → All external API calls instrumented: latency, status, tokens (Phase 2)
  → Errors aggregated in Sentry with full context (Phase 2)
  → Logs shipped to centralized store, searchable (Phase 2)
  → AI calls: model, tokens, cost tracked per call (Phase 2)
  → Dashboard: real-time error rate, latency p50/p95/p99 (Phase 3)
  → Alerting: automated paging on error rate spike (Phase 9)
```

## Consequences

- Phase 2 scope increases — observability infrastructure is mandatory, not optional
- Every new external API integration must include instrumentation from day one
- AI calls must go through an instrumented orchestration layer, not raw fetch
- Cost tracking enables informed decisions on model tiering and caching
- Chaos engineering in Phase 9 validates all earlier observability investments
