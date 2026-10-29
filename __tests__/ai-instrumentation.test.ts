/**
 * __tests__/ai-instrumentation.test.ts — Instrumentation tests
 *
 * Tests: cost estimation, metrics recording, buffer management,
 * aggregation/summary.
 */

import {
  estimateCost,
  recordMetrics,
  getRecentMetrics,
  clearMetrics,
  summarizeMetrics,
} from "@/platform/ai/instrumentation";
import { MODEL_REGISTRY } from "@/platform/ai/types";
import type { AICallMetrics } from "@/platform/ai/types";

beforeEach(() => {
  clearMetrics();
});

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

describe("estimateCost", () => {
  const M = 1_000_000;

  it("calculates cost for fast tier (Haiku)", () => {
    // Haiku 4.5: $1.00/1M input, $5.00/1M output
    const cost = estimateCost("fast", { inputTokens: M, outputTokens: M });
    expect(cost).toBeCloseTo(6.0, 2);
  });

  it("calculates cost for standard tier (Sonnet)", () => {
    // Sonnet 5.5: $2.00/1M input, $10.00/1M output
    const cost = estimateCost("standard", { inputTokens: M, outputTokens: M });
    expect(cost).toBeCloseTo(12.0, 2);
  });

  it.each(["fast", "standard"] as const)(
    "bills %s-tier cache reads and writes at the model's own prices, from the table",
    (tier) => {
      const c = MODEL_REGISTRY[tier];
      expect(
        estimateCost(tier, { inputTokens: 0, outputTokens: 0, cacheReadTokens: M })
      ).toBeCloseTo(c.cacheReadCostPer1M, 6);
      expect(
        estimateCost(tier, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: M })
      ).toBeCloseTo(c.cacheWriteCostPer1M, 6);
      // Every part of the usage counts: uncached input, reads, writes, output.
      expect(
        estimateCost(tier, {
          inputTokens: 3 * M,
          outputTokens: 2 * M,
          cacheReadTokens: 5 * M,
          cacheWriteTokens: 7 * M,
        })
      ).toBeCloseTo(
        3 * c.inputCostPer1M +
          2 * c.outputCostPer1M +
          5 * c.cacheReadCostPer1M +
          7 * c.cacheWriteCostPer1M,
        6
      );
    }
  );

  it("holds the published prices (platform.claude.com pricing, 2026-10-28)", () => {
    // Sonnet 5.5's cache hit is 0.05x its input price, not the generic 0.1x (the defect #462
    // shipped: it billed reads at $0.20/1M).
    expect(MODEL_REGISTRY.standard).toMatchObject({
      modelId: "claude-sonnet-5-5",
      inputCostPer1M: 2,
      outputCostPer1M: 10,
      cacheReadCostPer1M: 0.1,
      cacheWriteCostPer1M: 2.5,
    });
    expect(MODEL_REGISTRY.fast).toMatchObject({
      modelId: "claude-haiku-4-5-20251001",
      inputCostPer1M: 1,
      outputCostPer1M: 5,
      cacheReadCostPer1M: 0.1,
      cacheWriteCostPer1M: 1.25,
    });
  });

  it("handles small token counts", () => {
    const cost = estimateCost("fast", { inputTokens: 100, outputTokens: 50 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.001);
  });

  it("handles zero tokens, and a missing usage", () => {
    expect(estimateCost("fast", { inputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(estimateCost("fast", undefined)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Metrics recording
// ---------------------------------------------------------------------------

function createMetric(overrides?: Partial<AICallMetrics>): AICallMetrics {
  return {
    useCase: "test",
    requestId: "req-1",
    model: "claude-haiku-4-5-20251001",
    tier: "fast",
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.00028,
    latencyMs: 200,
    cached: false,
    success: true,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("recordMetrics / getRecentMetrics", () => {
  it("records and retrieves metrics", () => {
    recordMetrics(createMetric());
    recordMetrics(createMetric({ requestId: "req-2" }));

    const recent = getRecentMetrics();
    expect(recent).toHaveLength(2);
  });

  it("getRecentMetrics with count returns last N", () => {
    for (let i = 0; i < 10; i++) {
      recordMetrics(createMetric({ requestId: `req-${i}` }));
    }

    const last3 = getRecentMetrics(3);
    expect(last3).toHaveLength(3);
    expect(last3[0].requestId).toBe("req-7");
    expect(last3[2].requestId).toBe("req-9");
  });

  it("clearMetrics empties the buffer", () => {
    recordMetrics(createMetric());
    expect(getRecentMetrics()).toHaveLength(1);
    clearMetrics();
    expect(getRecentMetrics()).toHaveLength(0);
  });

  it("buffer does not exceed MAX_BUFFER_SIZE", () => {
    // Record 1010 entries — buffer should cap at 1000
    for (let i = 0; i < 1010; i++) {
      recordMetrics(createMetric({ requestId: `req-${i}` }));
    }
    expect(getRecentMetrics().length).toBeLessThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe("summarizeMetrics", () => {
  it("returns zeros for empty metrics", () => {
    const summary = summarizeMetrics([]);
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.errorRate).toBe(0);
  });

  it("aggregates totals correctly", () => {
    const metrics = [
      createMetric({
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0.001,
        latencyMs: 200,
      }),
      createMetric({
        inputTokens: 200,
        outputTokens: 100,
        estimatedCostUsd: 0.002,
        latencyMs: 300,
      }),
    ];

    const summary = summarizeMetrics(metrics);
    expect(summary.totalCalls).toBe(2);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(150);
    expect(summary.totalCostUsd).toBeCloseTo(0.003, 4);
    expect(summary.averageLatencyMs).toBe(250);
    expect(summary.errorRate).toBe(0);
  });

  it("calculates error rate", () => {
    const metrics = [
      createMetric({ success: true }),
      createMetric({ success: false }),
      createMetric({ success: true }),
      createMetric({ success: false }),
    ];

    const summary = summarizeMetrics(metrics);
    expect(summary.errorRate).toBeCloseTo(0.5, 2);
  });

  it("groups by useCase", () => {
    const metrics = [
      createMetric({ useCase: "safety", estimatedCostUsd: 0.001, latencyMs: 100 }),
      createMetric({ useCase: "safety", estimatedCostUsd: 0.002, latencyMs: 200 }),
      createMetric({ useCase: "admin", estimatedCostUsd: 0.01, latencyMs: 500 }),
    ];

    const summary = summarizeMetrics(metrics);
    expect(summary.byUseCase["safety"].calls).toBe(2);
    expect(summary.byUseCase["safety"].costUsd).toBeCloseTo(0.003, 4);
    expect(summary.byUseCase["admin"].calls).toBe(1);
    expect(summary.byUseCase["admin"].costUsd).toBeCloseTo(0.01, 4);
  });
});

// ---------------------------------------------------------------------------
// Model registry — no tier may point at a retired model
// ---------------------------------------------------------------------------

describe("MODEL_REGISTRY", () => {
  // Anthropic returns an error for every call to a retired model, so a tier left on one
  // fails every request routed to it. Add IDs here as Anthropic retires them.
  const RETIRED_MODEL_IDS = ["claude-sonnet-4-20250514", "claude-opus-4-20250514"];

  it.each(Object.entries(MODEL_REGISTRY))(
    "tier %s uses a model still served",
    (_tier, config) => {
      expect(RETIRED_MODEL_IDS).not.toContain(config.modelId);
    }
  );
});
