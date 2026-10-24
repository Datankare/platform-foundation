/**
 * platform/observability/metrics-sink.ts — Metrics persistence
 *
 * ADR-014: AI call instrumentation — per-call model, tokens, latency, cost.
 * ADR-015: Cost visibility from Phase 2 onward.
 *
 * Two implementations:
 *   InMemoryMetricsSink — in-process buffer, used in tests and when no DB available.
 *   PostgresMetricsSink — persists to the ai_metrics table, in the tenant each metric was
 *                         recorded for (ADR-053 D4), for historical dashboards.
 *
 * Consumers can implement MetricsSink for Prometheus, Datadog Metrics,
 * InfluxDB, CloudWatch, or any time-series backend.
 *
 * The sink receives MetricEvent objects from the AI instrumentation layer.
 * Events are buffered and flushed in batches for efficiency.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MetricsSink, MetricEvent, MetricsQueryOptions } from "./types";
import { logger } from "@/lib/logger";
import { hasDatabase, withTenantTx } from "@/platform/data";
import {
  peekTenant,
  runWithTenant,
  type TenantContext,
} from "@/platform/tenancy/context";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";

// ---------------------------------------------------------------------------
// In-Memory implementation — tests, dev, fallback
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BUFFER = 1000;

/**
 * InMemoryMetricsSink — stores metrics in a bounded buffer.
 *
 * Suitable for tests, local development, and as a fallback when no
 * external metrics store is configured. Metrics are lost on process restart.
 *
 * Kept per tenant (ADR-053 D6), as the Postgres sink's rows are: each tenant's events are a
 * separate bounded buffer, and record/query/getAll see only the current tenant's. Outside any
 * tenant they use the "no tenant" partition (platform/tenancy/partition.ts).
 */
export class InMemoryMetricsSink implements MetricsSink {
  private readonly buffers = new TenantPartitionedMap<"events", MetricEvent[]>();
  private readonly maxBuffer: number;

  constructor(maxBuffer = DEFAULT_MAX_BUFFER) {
    this.maxBuffer = maxBuffer;
  }

  private buffer(): MetricEvent[] {
    const part = this.buffers.current();
    let events = part.get("events");
    if (!events) {
      events = [];
      part.set("events", events);
    }
    return events;
  }

  record(event: MetricEvent): void {
    const buffer = this.buffer();
    buffer.push(event);
    if (buffer.length > this.maxBuffer) {
      buffer.shift();
    }
  }

  async flush(): Promise<void> {
    // In-memory — nothing to flush
  }

  async query(options: MetricsQueryOptions): Promise<readonly MetricEvent[]> {
    let results = [...this.buffer()];

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

  /** Get the current tenant's buffered events — for tests. */
  getAll(): readonly MetricEvent[] {
    return [...this.buffer()];
  }

  /** Clear every tenant's buffer — for tests. */
  clear(): void {
    this.buffers.clearAll();
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation — persistent metrics
// ---------------------------------------------------------------------------

/** Batch flush configuration. */
const FLUSH_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 10_000; // 10 seconds
/** After the first, a dropped no-tenant metric is logged once per this many. */
const NO_TENANT_WARN_EVERY = 100;

interface Pending {
  readonly tenant: TenantContext;
  readonly event: MetricEvent;
}

interface MetricRow {
  name: string;
  timestamp: Date;
  trace_id: string | null;
  values: Record<string, number>;
  tags: Record<string, string>;
}

/**
 * PostgresMetricsSink — persists metrics to the ai_metrics table through platform/data.
 *
 * Buffers events in memory and flushes in batches to reduce DB load. If the DB write fails,
 * events are logged as warnings and dropped (best-effort — metrics should never break the
 * request).
 *
 * Tenancy (ADR-053 D4): ai_metrics is tenant-owned (forced row-level security). Each event
 * remembers the tenant it was recorded in, and a flush writes each tenant's events in that
 * tenant's transaction — the flush timer runs outside any request, so the tenant cannot be read
 * at flush time. An event recorded with no tenant (a platform-level metric: boot, a probe, work
 * outside a request) has no row it may be written to: it is dropped, never thrown into the
 * caller, and counted (`droppedWithoutTenant`); the first such drop and every 100th after it are
 * logged. `query` reads the current tenant's metrics; with no tenant it returns [] like any
 * other failed query.
 *
 * Writes run detached from the caller's async context (captured when the sink is built), so a
 * batch flush started by `record` inside a caller's transaction never joins that transaction.
 *
 * Table (migrations 048_ai_metrics.sql, 049_tenancy.sql):
 *   id         UUID PRIMARY KEY
 *   name       TEXT NOT NULL
 *   timestamp  TIMESTAMPTZ NOT NULL
 *   trace_id   TEXT
 *   values     JSONB NOT NULL (object)
 *   tags       JSONB NOT NULL (object)
 *   created_at TIMESTAMPTZ DEFAULT now()
 *   tenant_id  UUID NOT NULL DEFAULT app_current_tenant()
 */
export class PostgresMetricsSink implements MetricsSink {
  private readonly buffer: Pending[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  /** Runs a function in the async context the sink was built in (no caller's tenant or tx). */
  private readonly detached = AsyncLocalStorage.snapshot();

  private ensureFlushTimer(): void {
    if (this.flushTimer) return;
    if (typeof setInterval === "undefined") return;

    // Created in the detached context: an interval keeps the context it was created in.
    this.flushTimer = this.detached(() =>
      setInterval(() => {
        this.flush().catch((err) =>
          logger.warn("Metrics auto-flush failed", { error: String(err) })
        );
      }, FLUSH_INTERVAL_MS)
    );

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
    const tenant = peekTenant();
    if (!tenant) {
      this.dropped++;
      if (this.dropped === 1 || this.dropped % NO_TENANT_WARN_EVERY === 0) {
        logger.warn(
          "Metric recorded outside any tenant — dropped (ai_metrics is per tenant)",
          {
            name: event.name,
            droppedWithoutTenant: this.dropped,
          }
        );
      }
      return;
    }

    this.ensureFlushTimer();
    this.buffer.push({ tenant, event });

    // Flush when buffer reaches batch size
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      this.flush().catch((err) =>
        logger.warn("Metrics batch flush failed", { error: String(err) })
      );
    }
  }

  /** How many metrics were dropped because they were recorded outside any tenant. */
  get droppedWithoutTenant(): number {
    return this.dropped;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Drain buffer into a local batch, one group per tenant.
    const batch = this.buffer.splice(0, this.buffer.length);
    const byTenant = new Map<string, { tenant: TenantContext; events: MetricEvent[] }>();
    for (const { tenant, event } of batch) {
      const group = byTenant.get(tenant.tenantId);
      if (group) group.events.push(event);
      else byTenant.set(tenant.tenantId, { tenant, events: [event] });
    }

    await this.detached(() =>
      Promise.all([...byTenant.values()].map((g) => this.write(g.tenant, g.events)))
    );
  }

  private async write(tenant: TenantContext, events: MetricEvent[]): Promise<void> {
    const rows = events.map((event) => ({
      name: event.name,
      timestamp: event.timestamp,
      trace_id: event.traceId ?? null,
      values: event.values,
      tags: event.tags,
    }));
    try {
      await runWithTenant(tenant, () =>
        withTenantTx((tx) =>
          tx.query(
            `insert into ai_metrics (name, "timestamp", trace_id, "values", tags)
             select r.name, r."timestamp", r.trace_id, r."values", r.tags
               from jsonb_to_recordset($1::jsonb)
                 as r(name text, "timestamp" timestamptz, trace_id text, "values" jsonb, tags jsonb)`,
            [JSON.stringify(rows)]
          )
        )
      );
    } catch (err) {
      logger.warn("Metrics flush failed", {
        error: err instanceof Error ? err.message : String(err),
        tenantId: tenant.tenantId,
        droppedCount: events.length,
      });
      // Don't re-buffer — metrics should never break the request
    }
  }

  async query(options: MetricsQueryOptions): Promise<readonly MetricEvent[]> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<MetricRow>(
          `select name, "timestamp", trace_id, "values", tags
             from ai_metrics
            where ($1::text is null or name = $1::text)
              and ($2::timestamptz is null or "timestamp" >= $2::timestamptz)
              and ($3::jsonb is null or tags @> $3::jsonb)
            order by "timestamp" desc
            limit $4::integer`,
          [
            options.name ?? null,
            options.since ?? null,
            options.tags ? JSON.stringify(options.tags) : null,
            options.limit || null, // 0 or absent: no limit, as before
          ]
        )
      );
      return rows.map((row) => ({
        name: row.name,
        timestamp: row.timestamp.toISOString(),
        traceId: row.trace_id ?? undefined,
        values: row.values,
        tags: row.tags,
      }));
    } catch (err) {
      logger.warn("Metrics query failed", {
        error: err instanceof Error ? err.message : String(err),
      });
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
 * Create a MetricsSink: the Postgres sink when a database is configured (DATABASE_URL),
 * otherwise the in-memory one. `persistent` overrides the check (tests).
 */
export function createMetricsSink(options: { persistent?: boolean } = {}): MetricsSink {
  if (options.persistent ?? hasDatabase()) {
    logger.info("Metrics sink: Postgres (persistent)");
    return new PostgresMetricsSink();
  }

  logger.info("Metrics sink: in-memory (non-persistent)");
  return new InMemoryMetricsSink();
}
