/**
 * __tests__/observability-metrics-sink.test.ts — Metrics sink tests
 *
 * Tests: InMemoryMetricsSink (record, query, buffer bounds, tenant partitions),
 * createMetricsSink factory. PostgresMetricsSink is tested against the real
 * database in __tests__/db/metrics-sink.db.test.ts.
 */

import { randomUUID } from "node:crypto";
import {
  InMemoryMetricsSink,
  PostgresMetricsSink,
  createMetricsSink,
} from "@/platform/observability/metrics-sink";
import type { MetricEvent } from "@/platform/observability/types";
import { runWithTenant } from "@/platform/tenancy/context";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";

function makeEvent(overrides: Partial<MetricEvent> = {}): MetricEvent {
  return {
    name: "ai.call",
    timestamp: new Date().toISOString(),
    traceId: "trace-1",
    values: { latencyMs: 200, inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
    tags: { model: "haiku", useCase: "classify" },
    ...overrides,
  };
}

describe("InMemoryMetricsSink", () => {
  let sink: InMemoryMetricsSink;

  beforeEach(() => {
    sink = new InMemoryMetricsSink();
  });

  it("records and retrieves events", () => {
    sink.record(makeEvent());
    sink.record(makeEvent({ name: "fetch.external" }));

    const all = sink.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("ai.call");
    expect(all[1].name).toBe("fetch.external");
  });

  it("respects buffer size limit", () => {
    const smallSink = new InMemoryMetricsSink(5);
    for (let i = 0; i < 10; i++) {
      smallSink.record(makeEvent({ traceId: `trace-${i}` }));
    }

    const all = smallSink.getAll();
    expect(all).toHaveLength(5);
    // Should keep the latest 5 (indices 5-9)
    expect(all[0].traceId).toBe("trace-5");
    expect(all[4].traceId).toBe("trace-9");
  });

  it("flush resolves immediately (in-memory)", async () => {
    sink.record(makeEvent());
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it("clear empties the buffer", () => {
    sink.record(makeEvent());
    sink.record(makeEvent());
    expect(sink.getAll()).toHaveLength(2);

    sink.clear();
    expect(sink.getAll()).toHaveLength(0);
  });

  describe("query", () => {
    beforeEach(() => {
      sink.record(
        makeEvent({ name: "ai.call", tags: { model: "haiku", useCase: "classify" } })
      );
      sink.record(
        makeEvent({ name: "ai.call", tags: { model: "sonnet", useCase: "generate" } })
      );
      sink.record(makeEvent({ name: "fetch.external", tags: { service: "translate" } }));
    });

    it("returns all events when no filters", async () => {
      const results = await sink.query({});
      expect(results).toHaveLength(3);
    });

    it("filters by name", async () => {
      const results = await sink.query({ name: "ai.call" });
      expect(results).toHaveLength(2);
    });

    it("filters by tags", async () => {
      const results = await sink.query({ tags: { model: "sonnet" } });
      expect(results).toHaveLength(1);
      expect(results[0].tags.useCase).toBe("generate");
    });

    it("filters by name + tags combined", async () => {
      const results = await sink.query({
        name: "ai.call",
        tags: { model: "haiku" },
      });
      expect(results).toHaveLength(1);
    });

    it("limits results", async () => {
      const results = await sink.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("filters by since timestamp", async () => {
      const futureEvent = makeEvent({
        name: "future",
        timestamp: new Date(Date.now() + 60_000).toISOString(),
      });
      sink.record(futureEvent);

      const results = await sink.query({
        since: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("future");
    });

    it("returns empty array when no matches", async () => {
      const results = await sink.query({ name: "nonexistent" });
      expect(results).toHaveLength(0);
    });
  });
});

describe("InMemoryMetricsSink — tenants (ADR-053 D6)", () => {
  runTenantIsolationContract({
    name: "metrics (memory)",
    makeStore: () => new InMemoryMetricsSink(),
    createTenant: async () => {
      const ctx = Object.freeze({ tenantId: randomUUID(), mode: "shared" as const });
      return { run: <T>(fn: () => T): T => runWithTenant(ctx, fn) };
    },
    write: async (sink, key) => {
      sink.record(makeEvent({ name: key }));
      await sink.flush();
    },
    read: async (sink, key) => {
      const r = await sink.query({ name: key });
      return r.length > 0 ? r : null;
    },
    failsClosedWithoutTenant: false,
  });

  it("bounds each tenant's buffer separately; clear() empties every tenant", async () => {
    const sink = new InMemoryMetricsSink(2);
    const a = { tenantId: randomUUID(), mode: "shared" as const };
    const b = { tenantId: randomUUID(), mode: "shared" as const };
    runWithTenant(a, () => {
      for (let i = 0; i < 3; i++) sink.record(makeEvent({ name: `a${i}` }));
    });
    runWithTenant(b, () => sink.record(makeEvent({ name: "b0" })));
    expect(runWithTenant(a, () => sink.getAll().map((e) => e.name))).toEqual([
      "a1",
      "a2",
    ]);
    expect(runWithTenant(b, () => sink.getAll().map((e) => e.name))).toEqual(["b0"]);
    expect(sink.getAll()).toEqual([]); // the "no tenant" partition
    sink.clear();
    expect(runWithTenant(a, () => sink.getAll())).toEqual([]);
    expect(runWithTenant(b, () => sink.getAll())).toEqual([]);
  });
});

describe("createMetricsSink", () => {
  const saved = process.env.DATABASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it("returns InMemoryMetricsSink when no database is configured", () => {
    delete process.env.DATABASE_URL;
    expect(createMetricsSink()).toBeInstanceOf(InMemoryMetricsSink);
    expect(createMetricsSink({})).toBeInstanceOf(InMemoryMetricsSink);
  });

  it("returns PostgresMetricsSink when DATABASE_URL is set", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    const sink = createMetricsSink();
    expect(sink).toBeInstanceOf(PostgresMetricsSink);
    (sink as PostgresMetricsSink).destroy();
  });

  it("honours an explicit persistent flag", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    expect(createMetricsSink({ persistent: false })).toBeInstanceOf(InMemoryMetricsSink);
    delete process.env.DATABASE_URL;
    const sink = createMetricsSink({ persistent: true });
    expect(sink).toBeInstanceOf(PostgresMetricsSink);
    (sink as PostgresMetricsSink).destroy();
  });
});
