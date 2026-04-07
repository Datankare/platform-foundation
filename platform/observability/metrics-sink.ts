/**
 * platform/observability/metrics-sink.ts — Metrics persistence
 *
 * ADR-014: AI call instrumentation — per-call model, tokens, latency, cost.
 * ADR-015: Cost visibility from Phase 2 onward.
 *
 * Two implementations:
 *   InMemoryMetricsSink — in-process buffer, used in tests and when no DB available.
 *   SupabaseMetricsSink — persists to ai_metrics table for historical dashboards.
 *
 * Consumers can implement MetricsSink for Prometheus, Datadog Metrics,
 * InfluxDB, CloudWatch, or any time-series backend.
 *
 * The sink receives MetricEvent objects from the AI instrumentation layer.
 * Events are buffered and flushed in batches for efficiency.
 */

import type { MetricsSink, MetricEvent, MetricsQueryOptions } from "./types";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// In-Memory implementation — tests, dev, fallback
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BUFFER = 1000;

/**
 * InMemoryMetricsSink — stores metrics in a bounded buffer.
 *
 * Suitable for tests, local development, and as a fallback when no
 * external metrics store is configured. Metrics are lost on process restart.
 */
export class InMemoryMetricsSink implements MetricsSink {
  private readonly buffer: MetricEvent[] = [];
  private readonly maxBuffer: number;

  constructor(maxBuffer = DEFAULT_MAX_BUFFER) {
    this.maxBuffer = maxBuffer;
  }

  record(event: MetricEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
    }
  }

  async flush(): Promise<void> {
    // In-memory — nothing to flush
  }

  async query(options: MetricsQueryOptions): Promise<readonly MetricEvent[]> {
    let results = [...this.buffer];

    if (options.name) {
      results = results.filter((e) => e.name === options.name);
    }
    if (options.tags) {
      for (const [key, value] of Object.entries(options.tags)) {
        results = results.filter((e) => e.tags[key] === value);
      }
    }
    if (options.since) {
      const since = new Date(options.since).getTime();
      results = results.filter((e) => new Date(e.timestamp).getTime() >= since);
    }
    if (options.limit) {
      results = results.slice(-options.limit);
    }

    return results;
  }

  /** Get all buffered events — for tests. */
  getAll(): readonly MetricEvent[] {
    return [...this.buffer];
  }

  /** Clear buffer — for tests. */
  clear(): void {
    this.buffer.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Supabase implementation — persistent metrics
// ---------------------------------------------------------------------------

/** Batch flush configuration. */
const FLUSH_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 10_000; // 10 seconds

/**
 * SupabaseMetricsSink — persists metrics to the ai_metrics table.
 *
 * Buffers events in memory and flushes in batches to reduce DB load.
 * If the DB write fails, events are logged as warnings (best-effort —
 * metrics should never break the request).
 *
 * Requires Supabase URL and service role key. If not configured,
 * falls back to InMemoryMetricsSink behavior with a startup warning.
 *
 * Table schema (migration 008):
 *   id         UUID PRIMARY KEY
 *   name       TEXT NOT NULL
 *   timestamp  TIMESTAMPTZ NOT NULL
 *   trace_id   TEXT
 *   values     JSONB NOT NULL
 *   tags       JSONB NOT NULL
 *   created_at TIMESTAMPTZ DEFAULT now()
 */
export class SupabaseMetricsSink implements MetricsSink {
  private readonly buffer: MetricEvent[] = [];
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) return;
    if (typeof setInterval === "undefined") return;

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) =>
        logger.warn("Metrics auto-flush failed", { error: String(err) })
      );
    }, FLUSH_INTERVAL_MS);

    // Don't block Node.js exit
    if (
      this.flushTimer &&
      typeof this.flushTimer === "object" &&
      "unref" in this.flushTimer
    ) {
      this.flushTimer.unref();
    }
  }

  record(event: MetricEvent): void {
    this.ensureFlushTimer();
    this.buffer.push(event);

    // Flush when buffer reaches batch size
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      this.flush().catch((err) =>
        logger.warn("Metrics batch flush failed", { error: String(err) })
      );
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    /* istanbul ignore next -- requires live Supabase; tested in integration tests (Sprint 6) */
    // Drain buffer into a local batch
    const batch = this.buffer.splice(0, this.buffer.length);

    const rows = batch.map((event) => ({
      name: event.name,
      timestamp: event.timestamp,
      trace_id: event.traceId ?? null,
      values: event.values,
      tags: event.tags,
    }));

    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/ai_metrics`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify(rows),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn("Metrics flush to Supabase failed", {
          status: response.status,
          error: text,
          droppedCount: batch.length,
        });
        // Don't re-buffer — metrics are best-effort
      }
    } catch (err) {
      logger.warn("Metrics flush network error", {
        error: String(err),
        droppedCount: batch.length,
      });
      // Don't re-buffer — metrics should never break the request
    }
  }

  async query(options: MetricsQueryOptions): Promise<readonly MetricEvent[]> {
    /* istanbul ignore next -- requires live Supabase; tested in integration tests (Sprint 6) */
    // Build Supabase REST query
    const params = new URLSearchParams();
    params.set("order", "timestamp.desc");

    if (options.name) {
      params.set("name", `eq.${options.name}`);
    }
    if (options.since) {
      params.set("timestamp", `gte.${options.since}`);
    }
    if (options.limit) {
      params.set("limit", String(options.limit));
    }

    try {
      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/ai_metrics?${params.toString()}`,
        {
          headers: {
            apikey: this.supabaseKey,
            Authorization: `Bearer ${this.supabaseKey}`,
          },
        }
      );

      if (!response.ok) return [];

      const rows = (await response.json()) as Array<{
        name: string;
        timestamp: string;
        trace_id: string | null;
        values: Record<string, number>;
        tags: Record<string, string>;
      }>;

      return rows.map((row) => ({
        name: row.name,
        timestamp: row.timestamp,
        traceId: row.trace_id ?? undefined,
        values: row.values,
        tags: row.tags,
      }));
    } catch (err) {
      logger.warn("Metrics query failed", { error: String(err) });
      return [];
    }
  }

  /** Stop the auto-flush timer — for cleanup. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a MetricsSink based on available configuration.
 * Returns InMemoryMetricsSink when Supabase is not configured.
 */
export function createMetricsSink(options: {
  supabaseUrl?: string;
  supabaseKey?: string;
}): MetricsSink {
  if (options.supabaseUrl && options.supabaseKey) {
    logger.info("Metrics sink: Supabase (persistent)");
    return new SupabaseMetricsSink(options.supabaseUrl, options.supabaseKey);
  }

  logger.info("Metrics sink: in-memory (non-persistent)");
  return new InMemoryMetricsSink();
}
