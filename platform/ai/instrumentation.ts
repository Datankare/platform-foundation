/**
 * platform/ai/instrumentation.ts — AI call metrics and cost tracking
 *
 * ADR-014: Observability — every AI call automatically instrumented.
 * ADR-015: Cost visibility from Phase 2 onward.
 *
 * Currently logs structured metrics via the platform logger.
 * Phase 3 adds Sentry spans and Datadog APM integration.
 */

import { AICallMetrics, ModelTier, MODEL_REGISTRY } from "./types";
import { logger } from "@/lib/logger";

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

/** In-memory metrics buffer — replaced by external sink in Phase 3 */
const metricsBuffer: AICallMetrics[] = [];
const MAX_BUFFER_SIZE = 1000;

export function recordMetrics(metrics: AICallMetrics): void {
  // Structured log — searchable in log aggregation (Phase 3)
  logger.info("ai_call", {
    ...metrics,
    // Override logger's default message field
    message: `AI call: ${metrics.useCase} → ${metrics.model} (${metrics.latencyMs}ms, $${metrics.estimatedCostUsd})`,
  });

  // Buffer for in-process aggregation (replaced by external store in Phase 3)
  metricsBuffer.push(metrics);
  if (metricsBuffer.length > MAX_BUFFER_SIZE) {
    metricsBuffer.shift();
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
