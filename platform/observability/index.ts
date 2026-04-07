/**
 * platform/observability/index.ts — Observability bootstrap and access
 *
 * ADR-014: Observability is fabric, not a bolt-on.
 *
 * Call initObservability() once at app startup. After initialization,
 * use getObservability() anywhere to access the configured providers.
 *
 * Pattern: same as auth — initialize once, access globally.
 *
 * Usage:
 *   // App startup (e.g., instrumentation.ts or layout.tsx)
 *   initObservability({
 *     sentryDsn: process.env.SENTRY_DSN,
 *     environment: process.env.NODE_ENV ?? "development",
 *     version: "1.1.1",
 *     healthProbes: [
 *       new SupabaseHealthProbe(supabaseUrl, supabaseKey),
 *       new LLMProviderHealthProbe(anthropicKey),
 *     ],
 *   });
 *
 *   // Anywhere in the app
 *   const { tracer, errors, metrics, health } = getObservability();
 *   const trace = tracer.createTrace();
 *   errors.captureError(new Error("oops"), { traceContext: trace });
 */

import type {
  ObservabilityConfig,
  ErrorReporter,
  TraceProvider,
  MetricsSink,
} from "./types";
import { DefaultTraceProvider } from "./tracing";
import { createErrorReporter } from "./error-reporting";
import { createMetricsSink } from "./metrics-sink";
import { HealthRegistry } from "./health";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

interface ObservabilityState {
  errors: ErrorReporter;
  tracer: TraceProvider;
  metrics: MetricsSink;
  health: HealthRegistry;
}

let state: ObservabilityState | null = null;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialize the observability stack. Call once at app startup.
 *
 * All providers are configurable — pass custom implementations via
 * ObservabilityConfig to swap any component:
 *
 *   initObservability({
 *     ...baseConfig,
 *     errorReporter: new DatadogErrorReporter({ apiKey: "..." }),
 *     metricsSink: new PrometheusMetricsSink({ endpoint: "..." }),
 *   });
 */
export function initObservability(config: ObservabilityConfig): void {
  if (state) {
    logger.warn("Observability already initialized — reinitializing");
    // Clean up previous metrics sink timers
    const sink = state.metrics as { destroy?: () => void };
    if (typeof sink.destroy === "function") {
      sink.destroy();
    }
  }

  // Error Reporter — custom or default (Sentry/NoOp)
  const errors =
    config.errorReporter ??
    createErrorReporter({
      sentryDsn: config.sentryDsn,
      environment: config.environment,
      version: config.version,
      traceSampleRate: config.traceSampleRate,
    });
  errors.init();

  // Trace Provider — custom or default
  const tracer = config.traceProvider ?? new DefaultTraceProvider();

  // Metrics Sink — custom or default (Supabase/InMemory)
  const metrics =
    config.metricsSink ??
    createMetricsSink({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });

  // Health Registry — version-stamped
  const health = new HealthRegistry(config.version);
  if (config.healthProbes) {
    for (const probe of config.healthProbes) {
      health.register(probe);
    }
  }

  state = { errors, tracer, metrics, health };

  logger.info("Observability initialized", {
    environment: config.environment,
    version: config.version,
    hasSentry: !!config.sentryDsn,
    traceProvider: config.traceProvider ? "custom" : "default",
    metricsSink: config.metricsSink ? "custom" : "default",
    healthProbes: health.getProbeNames().join(", ") || "none",
  });
}

// ---------------------------------------------------------------------------
// Access — use after initialization
// ---------------------------------------------------------------------------

/**
 * Get the initialized observability providers.
 * Throws if called before initObservability().
 */
export function getObservability(): ObservabilityState {
  if (!state) {
    throw new Error(
      "Observability not initialized. Call initObservability() at app startup."
    );
  }
  return state;
}

/**
 * Safe access — returns providers or null if not yet initialized.
 * Use in code paths that may run before initialization (e.g., module-level).
 */
export function tryGetObservability(): ObservabilityState | null {
  return state;
}

// ---------------------------------------------------------------------------
// Convenience re-exports
// ---------------------------------------------------------------------------

export type {
  // Core types
  TraceContext,
  SpanData,
  SpanStatus,
  TraceHeaders,
  MetricEvent,
  MetricsQueryOptions,
  HealthCheckResult,
  HealthReport,
  HealthStatus,
  // Interfaces (for consumer implementations)
  ErrorReporter,
  ErrorContext,
  TraceProvider,
  MetricsSink,
  HealthProbe,
  ObservabilityConfig,
} from "./types";

// Implementations (for direct use)
export { DefaultTraceProvider, generateTraceId, generateSpanId } from "./tracing";
export {
  NoopErrorReporter,
  SentryErrorReporter,
  createErrorReporter,
} from "./error-reporting";
export {
  InMemoryMetricsSink,
  SupabaseMetricsSink,
  createMetricsSink,
} from "./metrics-sink";
export {
  HealthRegistry,
  SupabaseHealthProbe,
  LLMProviderHealthProbe,
  HttpHealthProbe,
} from "./health";

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/** Reset observability state — for tests only. */
export function resetObservability(): void {
  if (state) {
    // Clean up any timers (e.g., SupabaseMetricsSink auto-flush interval)
    const sink = state.metrics as { destroy?: () => void };
    if (typeof sink.destroy === "function") {
      sink.destroy();
    }
  }
  state = null;
}
