/**
 * __tests__/contract/metrics-sink-contract.ts
 * MetricsSink conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type { MetricsSink, MetricEvent } from "@/platform/observability/types";

function event(name: string): MetricEvent {
  return {
    name,
    timestamp: new Date().toISOString(),
    values: { latencyMs: 12 },
    tags: { provider: "contract" },
  };
}

export interface MetricsSinkContractFixtures {
  makeSink: () => MetricsSink | Promise<MetricsSink>;
}

export function runMetricsSinkContract(fx: MetricsSinkContractFixtures): void {
  let sink: MetricsSink;

  beforeEach(async () => {
    sink = await fx.makeSink();
  });

  describe("record / query", () => {
    it("returns a recorded event by name", async () => {
      sink.record(event("contract.metric"));
      await sink.flush();
      const results = await sink.query({ name: "contract.metric" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((e) => e.name === "contract.metric")).toBe(true);
    });

    it("filters out non-matching names", async () => {
      sink.record(event("contract.a"));
      sink.record(event("contract.b"));
      await sink.flush();
      const results = await sink.query({ name: "contract.a" });
      expect(results.every((e) => e.name === "contract.a")).toBe(true);
    });

    it("respects a result limit", async () => {
      sink.record(event("contract.limited"));
      sink.record(event("contract.limited"));
      sink.record(event("contract.limited"));
      await sink.flush();
      const results = await sink.query({ name: "contract.limited", limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe("flush", () => {
    it("resolves", async () => {
      await expect(sink.flush()).resolves.toBeUndefined();
    });
  });
}
