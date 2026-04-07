/**
 * platform/observability/types.ts — Observability abstractions
 *
 * ADR-014: Observability is fabric, not a bolt-on.
 * Standing Rule 9: Every external API integration instrumented from day one.
 *
 * All observability components sit behind interfaces. Consumers swap
 * implementations (e.g., Sentry → Datadog) via configuration, not rewrites.
 * Same pattern as auth/Cognito — PF provides interfaces + default impls,
 * consumers provide concrete alternatives.
 *
 * Default implementations:
 *   ErrorReporter  → SentryErrorReporter (no-op when SENTRY_DSN absent)
 *   TraceProvider  → DefaultTraceProvider (generates trace/span IDs, propagates headers)
 *   MetricsSink    → SupabaseMetricsSink (persists to ai_metrics table)
 *   HealthProbe    → built-in probes for Supabase, LLM provider
 */

// ---------------------------------------------------------------------------
// Trace Context — flows through every request
// ---------------------------------------------------------------------------

/** Immutable context propagated across all operations in a single request. */
export interface TraceContext {
  /** Unique ID for the entire request (e.g., API call → safety → AI → response). */
  readonly traceId: string;
  /** Unique ID for the current operation within the trace. */
  readonly spanId: string;
  /** Parent span ID — undefined for root spans. */
  readonly parentSpanId?: string;
  /** ISO timestamp when the trace started. */
  readonly startedAt: string;
}

// ---------------------------------------------------------------------------
// Span — a single timed operation within a trace
// ---------------------------------------------------------------------------

export type SpanStatus = "ok" | "error" | "timeout";

/** A single timed operation within a trace. */
export interface SpanData {
  /** Span name — identifies the operation (e.g., "ai.classify", "fetch.translate"). */
  readonly name: string;
  /** The trace this span belongs to. */
  readonly traceId: string;
  /** Unique ID for this span. */
  readonly spanId: string;
  /** Parent span ID — links to the caller. */
  readonly parentSpanId?: string;
  /** ISO timestamp when the span started. */
  readonly startedAt: string;
  /** ISO timestamp when the span ended. */
  readonly endedAt: string;
  /** Duration in milliseconds. */
  readonly durationMs: number;
  /** Outcome of the operation. */
  readonly status: SpanStatus;
  /** Arbitrary key-value attributes for filtering/searching. */
  readonly attributes: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Error Reporter — captures and aggregates errors
// ---------------------------------------------------------------------------

export interface ErrorContext {
  /** Current trace context, if available. */
  traceContext?: TraceContext;
  /** The user associated with this error (never PII — use anonymized ID). */
  userId?: string;
  /** Arbitrary tags for filtering (e.g., { route: "/api/process", method: "POST" }). */
  tags?: Record<string, string>;
  /** Arbitrary structured data attached to the error event. */
  extra?: Record<string, unknown>;
}

/**
 * ErrorReporter — interface for error tracking services.
 *
 * Default: SentryErrorReporter (no-op when SENTRY_DSN not set).
 * Consumers can swap to Datadog, Bugsnag, New Relic, or custom.
 */
export interface ErrorReporter {
  /** Initialize the reporter. Called once at app startup. */
  init(): void;

  /** Capture an error with optional context. */
  captureError(error: Error, context?: ErrorContext): void;

  /** Capture a non-error message (warning, info) for aggregation. */
  captureMessage(
    message: string,
    level: "info" | "warning" | "error",
    context?: ErrorContext
  ): void;

  /** Set the current user context (anonymized ID only). */
  setUser(userId: string | null): void;

  /** Flush pending events — call before serverless function exits. */
  flush(timeoutMs?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Trace Provider — distributed tracing
// ---------------------------------------------------------------------------

/** Headers used to propagate trace context across service boundaries. */
export interface TraceHeaders {
  readonly "x-trace-id": string;
  readonly "x-span-id": string;
  readonly "x-parent-span-id"?: string;
}

/**
 * TraceProvider — interface for distributed tracing.
 *
 * Default: DefaultTraceProvider (generates IDs, propagates via x-trace-id headers).
 * Consumers can swap to OpenTelemetry, Sentry Performance, Datadog APM.
 */
export interface TraceProvider {
  /** Create a new root trace (top-level request). */
  createTrace(): TraceContext;

  /** Create a child span within an existing trace. */
  createSpan(parent: TraceContext, name: string): TraceContext;

  /** Extract trace context from incoming request headers. */
  extractFromHeaders(headers: Record<string, string | undefined>): TraceContext | null;

  /** Generate headers for propagating trace context to downstream calls. */
  toHeaders(context: TraceContext): TraceHeaders;

  /** Record a completed span. */
  recordSpan(span: SpanData): void;

  /** End a span — calculates duration and records it. */
  endSpan(
    context: TraceContext,
    name: string,
    status: SpanStatus,
    attributes?: Record<string, string | number | boolean>
  ): SpanData;
}

// ---------------------------------------------------------------------------
// Metrics Sink — persists operational metrics
// ---------------------------------------------------------------------------

/** A single metric data point. */
export interface MetricEvent {
  /** Metric name (e.g., "ai.call", "fetch.external", "moderation.scan"). */
  readonly name: string;
  /** ISO timestamp of the event. */
  readonly timestamp: string;
  /** Trace ID for correlation. */
  readonly traceId?: string;
  /** Numeric values (e.g., latencyMs, inputTokens, costUsd). */
  readonly values: Record<string, number>;
  /** String tags for filtering (e.g., model, useCase, provider). */
  readonly tags: Record<string, string>;
}

/**
 * MetricsSink — interface for persisting operational metrics.
 *
 * Default: SupabaseMetricsSink (writes to ai_metrics table).
 * Consumers can swap to Prometheus, Datadog Metrics, InfluxDB, or custom.
 */
export interface MetricsSink {
  /** Record a single metric event. Implementations should batch/buffer internally. */
  record(event: MetricEvent): void;

  /** Flush buffered metrics to the backing store. */
  flush(): Promise<void>;

  /** Query recent metrics — for admin dashboards and tests. */
  query(options: MetricsQueryOptions): Promise<readonly MetricEvent[]>;
}

export interface MetricsQueryOptions {
  /** Filter by metric name. */
  name?: string;
  /** Filter by tag values. */
  tags?: Record<string, string>;
  /** Maximum number of results. */
  limit?: number;
  /** Return events after this ISO timestamp. */
  since?: string;
}

// ---------------------------------------------------------------------------
// Health Probe — dependency health checking
// ---------------------------------------------------------------------------

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** Result of a single dependency health check. */
export interface HealthCheckResult {
  /** Dependency name (e.g., "supabase", "anthropic", "redis"). */
  readonly name: string;
  /** Current status. */
  readonly status: HealthStatus;
  /** Response time in milliseconds (undefined if check failed before response). */
  readonly latencyMs?: number;
  /** Human-readable detail (e.g., "Connection refused", "200 OK"). */
  readonly detail?: string;
  /** ISO timestamp of the check. */
  readonly checkedAt: string;
}

/** Aggregated health report across all dependencies. */
export interface HealthReport {
  /** Overall status — worst of all individual statuses. */
  readonly status: HealthStatus;
  /** Individual dependency results. */
  readonly checks: readonly HealthCheckResult[];
  /** ISO timestamp of the report. */
  readonly timestamp: string;
  /** Platform version. */
  readonly version: string;
}

/**
 * HealthProbe — interface for checking a single dependency's health.
 *
 * Consumers register probes for their specific dependencies.
 * PF provides default probes for Supabase and LLM provider.
 */
export interface HealthProbe {
  /** Dependency name — must be unique across all registered probes. */
  readonly name: string;

  /** Run the health check. Must complete within timeoutMs. */
  check(timeoutMs?: number): Promise<HealthCheckResult>;
}

// ---------------------------------------------------------------------------
// Observability Configuration
// ---------------------------------------------------------------------------

/** Configuration for the observability bootstrap. */
export interface ObservabilityConfig {
  /** Sentry DSN. When absent, error reporter operates as no-op. */
  sentryDsn?: string;
  /** Application environment (e.g., "production", "staging", "development"). */
  environment: string;
  /** Application version — attached to all error reports and traces. */
  version: string;
  /** Enable/disable performance tracing. Default: true when sentryDsn is set. */
  enableTracing?: boolean;
  /** Sample rate for performance traces (0.0–1.0). Default: 1.0 in dev, 0.1 in production. */
  traceSampleRate?: number;
  /** Registered health probes. */
  healthProbes?: HealthProbe[];
  /** Custom error reporter — overrides default Sentry implementation. */
  errorReporter?: ErrorReporter;
  /** Custom trace provider — overrides default implementation. */
  traceProvider?: TraceProvider;
  /** Custom metrics sink — overrides default Supabase implementation. */
  metricsSink?: MetricsSink;
}
