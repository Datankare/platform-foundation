# platform/observability/

> Observability is fabric, not a bolt-on. — ADR-014

Pluggable observability infrastructure for error tracking, distributed tracing,
metrics persistence, and dependency health monitoring. Every component sits
behind an interface — swap implementations without changing application code.

## Quick Start

```typescript
import {
  initObservability,
  getObservability,
  SupabaseHealthProbe,
  LLMProviderHealthProbe,
} from "@/platform/observability";

// Initialize once at app startup
initObservability({
  sentryDsn: process.env.SENTRY_DSN, // optional — no-op when absent
  environment: process.env.NODE_ENV ?? "development",
  version: "1.1.1",
  healthProbes: [
    new SupabaseHealthProbe(supabaseUrl, supabaseKey),
    new LLMProviderHealthProbe(anthropicKey),
  ],
});

// Use anywhere
const { tracer, errors, metrics, health } = getObservability();
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  initObservability()                      │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ErrorReporter │  │TraceProvider │  │ MetricsSink  │  │
│  │  (interface) │  │  (interface) │  │  (interface) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │           │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐  │
│  │    Sentry    │  │   Default    │  │  Supabase    │  │
│  │  (default)   │  │  (default)   │  │  (default)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │             HealthRegistry                        │   │
│  │  SupabaseProbe │ LLMProviderProbe │ HttpProbe    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Components

### ErrorReporter

Captures and aggregates errors with trace context.

| Implementation        | When Used                        | Dependency                       |
| --------------------- | -------------------------------- | -------------------------------- |
| `NoopErrorReporter`   | Default when no `SENTRY_DSN` set | None                             |
| `SentryErrorReporter` | When `SENTRY_DSN` is configured  | `@sentry/nextjs` (optional peer) |

### TraceProvider

Distributed tracing — generates trace/span IDs, propagates context via headers.

| Implementation         | When Used                  | Dependency |
| ---------------------- | -------------------------- | ---------- |
| `DefaultTraceProvider` | Always (unless overridden) | None       |

Trace context propagated via `x-trace-id`, `x-span-id`, `x-parent-span-id` headers.

### MetricsSink

Persists operational metrics (AI calls, external API calls, moderation scans).

| Implementation        | When Used                                | Dependency          |
| --------------------- | ---------------------------------------- | ------------------- |
| `InMemoryMetricsSink` | Default when no Supabase config          | None                |
| `SupabaseMetricsSink` | When `SUPABASE_URL` + `SUPABASE_KEY` set | Supabase (existing) |

### HealthProbe

Dependency health checking — aggregated into a single HealthReport.

| Probe                    | Checks                                    | Built-in |
| ------------------------ | ----------------------------------------- | -------- |
| `SupabaseHealthProbe`    | Database availability                     | Yes      |
| `LLMProviderHealthProbe` | Anthropic API reachability + key validity | Yes      |
| `HttpHealthProbe`        | Any HTTP endpoint                         | Yes      |

## Swapping Implementations (Consumer Guide)

### Replace Sentry with Datadog

```typescript
import { initObservability } from "@/platform/observability";
import type { ErrorReporter } from "@/platform/observability";

class DatadogErrorReporter implements ErrorReporter {
  init() {
    /* initialize Datadog SDK */
  }
  captureError(error, context?) {
    /* send to Datadog */
  }
  captureMessage(message, level, context?) {
    /* send to Datadog */
  }
  setUser(userId) {
    /* set Datadog user context */
  }
  async flush(timeoutMs?) {
    /* flush Datadog buffer */
  }
}

initObservability({
  environment: "production",
  version: "2.0.0",
  errorReporter: new DatadogErrorReporter(),
});
```

### Replace Supabase Metrics with Prometheus

```typescript
import type {
  MetricsSink,
  MetricEvent,
  MetricsQueryOptions,
} from "@/platform/observability";

class PrometheusMetricsSink implements MetricsSink {
  record(event: MetricEvent) {
    /* push to Prometheus pushgateway */
  }
  async flush() {
    /* flush pending metrics */
  }
  async query(options: MetricsQueryOptions) {
    /* query Prometheus */
  }
}

initObservability({
  environment: "production",
  version: "2.0.0",
  metricsSink: new PrometheusMetricsSink(),
});
```

### Add Custom Health Probes

```typescript
import { initObservability, HttpHealthProbe } from "@/platform/observability";
import type { HealthProbe, HealthCheckResult } from "@/platform/observability";

class RedisHealthProbe implements HealthProbe {
  readonly name = "redis";
  async check(timeoutMs?: number): Promise<HealthCheckResult> {
    // ping Redis, return result
  }
}

initObservability({
  environment: "production",
  version: "2.0.0",
  healthProbes: [
    new RedisHealthProbe(),
    new HttpHealthProbe("search", "http://search:9200/_cluster/health"),
  ],
});
```

## Logger Integration

The platform logger (`lib/logger.ts`) supports trace context injection:

```typescript
const trace = tracer.createTrace();
const log = logger.withTrace(trace.traceId, trace.spanId);

log.info("Processing request");
// Output: { "traceId": "abc123...", "spanId": "def456...", "message": "Processing request", ... }
```

### Log Entry Schema

Every log entry is structured JSON with these fields:

| Field         | Type              | Always Present      | Description                         |
| ------------- | ----------------- | ------------------- | ----------------------------------- |
| `timestamp`   | string (ISO 8601) | Yes                 | When the event occurred             |
| `level`       | string            | Yes                 | `error`, `warn`, `info`, or `debug` |
| `environment` | string            | Yes                 | `NODE_ENV` value                    |
| `message`     | string            | Yes                 | Human-readable summary              |
| `traceId`     | string            | When traced         | 32-char hex trace ID                |
| `spanId`      | string            | When traced         | 16-char hex span ID                 |
| `requestId`   | string            | On API requests     | Short correlation ID (legacy)       |
| `route`       | string            | On API requests     | API route path                      |
| `method`      | string            | On API requests     | HTTP method                         |
| `status`      | number            | On API responses    | HTTP status code                    |
| `durationMs`  | number            | On timed operations | Duration in milliseconds            |
| `error`       | string            | On errors           | Error message                       |

Configure log level via `LOG_LEVEL` environment variable: `error` (default), `warn`, `info`, `debug`, `silent`.

## AI Instrumentation Integration

AI call metrics are automatically forwarded to the MetricsSink:

```typescript
// platform/ai/orchestrator.ts calls recordMetrics() on every AI call.
// recordMetrics() forwards to MetricsSink when observability is initialized.
// No code changes needed — it just works.
```

Metric events have name `"ai.call"` with these values and tags:

| Values                                                                    | Tags                                 |
| ------------------------------------------------------------------------- | ------------------------------------ |
| `inputTokens`, `outputTokens`, `latencyMs`, `estimatedCostUsd`, `success` | `model`, `tier`, `useCase`, `cached` |

## File Structure

```
platform/observability/
├── types.ts           ← All interfaces (ErrorReporter, TraceProvider, MetricsSink, HealthProbe)
├── error-reporting.ts ← NoopErrorReporter, SentryErrorReporter, factory
├── tracing.ts         ← DefaultTraceProvider, ID generators
├── metrics-sink.ts    ← InMemoryMetricsSink, SupabaseMetricsSink, factory
├── health.ts          ← HealthRegistry, SupabaseHealthProbe, LLMProviderHealthProbe, HttpHealthProbe
├── index.ts           ← Bootstrap (initObservability), access (getObservability), re-exports
└── README.md          ← This file
```
