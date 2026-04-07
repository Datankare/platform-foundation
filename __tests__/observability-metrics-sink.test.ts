/**
 * __tests__/observability-metrics-sink.test.ts — Metrics sink tests
 *
 * Tests: InMemoryMetricsSink (record, query, buffer bounds),
 * createMetricsSink factory. SupabaseMetricsSink tested via
 * integration tests (Phase 2 Sprint 6) since it requires live DB.
 */

import {
  InMemoryMetricsSink,
  SupabaseMetricsSink,
  createMetricsSink,
} from "@/platform/observability/metrics-sink";
import type { MetricEvent } from "@/platform/observability/types";

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

describe("createMetricsSink", () => {
  it("returns InMemoryMetricsSink when no Supabase config", () => {
    const sink = createMetricsSink({});
    expect(sink).toBeInstanceOf(InMemoryMetricsSink);
  });

  it("returns InMemoryMetricsSink when only URL (no key)", () => {
    const sink = createMetricsSink({ supabaseUrl: "https://example.supabase.co" });
    expect(sink).toBeInstanceOf(InMemoryMetricsSink);
  });

  it("returns InMemoryMetricsSink when only key (no URL)", () => {
    const sink = createMetricsSink({ supabaseKey: "fake-key" });
    expect(sink).toBeInstanceOf(InMemoryMetricsSink);
  });

  // SupabaseMetricsSink construction tested but not flushed (requires live DB)
  it("returns SupabaseMetricsSink when both URL and key provided", () => {
    const sink = createMetricsSink({
      supabaseUrl: "https://example.supabase.co",
      supabaseKey: "fake-key",
    });
    expect(sink).toBeInstanceOf(SupabaseMetricsSink);
    // Clean up timer
    (sink as { destroy?: () => void }).destroy?.();
  });
});
