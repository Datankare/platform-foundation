/**
 * platform/ai/instrumentation.ts — AI call metrics and cost tracking
 *
 * ADR-014: Observability — every AI call automatically instrumented.
 * ADR-015: Cost visibility from Phase 2 onward.
 *
 * Records metrics through two channels:
 *   1. In-memory buffer (always available — backwards compatible)
 *   2. Observability MetricsSink (when initialized — persistent storage)
 *
 * Errors are forwarded to the ErrorReporter when observability is initialized.
 */

import { AICallMetrics, ModelTier, MODEL_REGISTRY } from "./types";
import { logger } from "@/lib/logger";
import { tryGetObservability } from "@/platform/observability";

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

export function estimateCost(
  tier: ModelTier,
  inputTokens: number,
  outputTokens: number
): number {
  const config = MODEL_REGISTRY[tier];
  const inputCost = (inputTokens / 1_000_000) * config.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * config.outputCostPer1M;
  return parseFloat((inputCost + outputCost).toFixed(6));
}

// ---------------------------------------------------------------------------
// Metrics recording
// ---------------------------------------------------------------------------

/** In-memory metrics buffer — always available, even without observability. */
const metricsBuffer: AICallMetrics[] = [];
const MAX_BUFFER_SIZE = 1000;

export function recordMetrics(metrics: AICallMetrics): void {
  // Structured log — searchable in log aggregation
  logger.info("ai_call", {
    ...metrics,
    message: `AI call: ${metrics.useCase} → ${metrics.model} (${metrics.latencyMs}ms, $${metrics.estimatedCostUsd})`,
  });

  // In-memory buffer (always available)
  metricsBuffer.push(metrics);
  if (metricsBuffer.length > MAX_BUFFER_SIZE) {
    metricsBuffer.shift();
  }

  // Forward to MetricsSink (persistent storage — when observability is initialized)
  const obs = tryGetObservability();
  if (obs) {
    obs.metrics.record({
      name: "ai.call",
      timestamp: new Date().toISOString(),
      traceId: metrics.traceId,
      values: {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        latencyMs: metrics.latencyMs,
        estimatedCostUsd: metrics.estimatedCostUsd,
        success: metrics.success ? 1 : 0,
      },
      tags: {
        model: metrics.model,
        tier: metrics.tier,
        useCase: metrics.useCase,
        cached: String(metrics.cached ?? false),
      },
    });

    // Forward errors to ErrorReporter
    if (!metrics.success && metrics.error) {
      obs.errors.captureMessage(
        `AI call failed: ${metrics.useCase} → ${metrics.model}: ${metrics.error}`,
        "error",
        { tags: { model: metrics.model, useCase: metrics.useCase } }
      );
    }
  }
}

/**
 * Get buffered metrics — useful for admin dashboards and tests.
 * In Phase 3, this will query the external metrics store instead.
 */
export function getRecentMetrics(count?: number): readonly AICallMetrics[] {
  const n = count ?? metricsBuffer.length;
  return metricsBuffer.slice(-n);
}

/** Clear metrics buffer — used in tests */
export function clearMetrics(): void {
  metricsBuffer.length = 0;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export interface MetricsSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  errorRate: number;
  byUseCase: Record<
    string,
    {
      calls: number;
      costUsd: number;
      avgLatencyMs: number;
    }
  >;
}

export function summarizeMetrics(metrics: readonly AICallMetrics[]): MetricsSummary {
  if (metrics.length === 0) {
    return {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      averageLatencyMs: 0,
      errorRate: 0,
      byUseCase: {},
    };
  }

  const byUseCase: MetricsSummary["byUseCase"] = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let totalLatency = 0;
  let errors = 0;

  for (const m of metrics) {
    totalInput += m.inputTokens;
    totalOutput += m.outputTokens;
    totalCost += m.estimatedCostUsd;
    totalLatency += m.latencyMs;
    if (!m.success) errors++;

    if (!byUseCase[m.useCase]) {
      byUseCase[m.useCase] = { calls: 0, costUsd: 0, avgLatencyMs: 0 };
    }
    const uc = byUseCase[m.useCase];
    uc.costUsd += m.estimatedCostUsd;
    uc.avgLatencyMs = (uc.avgLatencyMs * uc.calls + m.latencyMs) / (uc.calls + 1);
    uc.calls++;
  }

  return {
    totalCalls: metrics.length,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCostUsd: parseFloat(totalCost.toFixed(6)),
    averageLatencyMs: Math.round(totalLatency / metrics.length),
    errorRate: parseFloat((errors / metrics.length).toFixed(4)),
    byUseCase,
  };
}
