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
import type { AICallMetrics } from "@/platform/ai/types";

beforeEach(() => {
  clearMetrics();
});

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

describe("estimateCost", () => {
  it("calculates cost for fast tier (Haiku)", () => {
    // Haiku: $0.80/1M input, $4.00/1M output
    const cost = estimateCost("fast", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(4.8, 2);
  });

  it("calculates cost for standard tier (Sonnet)", () => {
    // Sonnet: $3.00/1M input, $15.00/1M output
    const cost = estimateCost("standard", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18.0, 2);
  });

  it("handles small token counts", () => {
    const cost = estimateCost("fast", 100, 50);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.001);
  });

  it("handles zero tokens", () => {
    const cost = estimateCost("fast", 0, 0);
    expect(cost).toBe(0);
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
