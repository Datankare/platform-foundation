/**
 * __tests__/helpers/mock-health-probe.ts — Deterministic mock health probe
 *
 * Reference HealthProbe for tests and the conformance kit (ADR-027). Returns a
 * configurable status with zero network. The built-in probes (database, LLM,
 * HTTP) are all network-bound, so this provides the offline reference the
 * HealthProbe contract runs against. Mirrors createMockAIProvider.
 *
 * A test double, so it lives with the tests (TASK-211, N-118: it was
 * platform/observability/mock-health-probe.ts, a module no entry point loads).
 */

import type {
  HealthProbe,
  HealthCheckResult,
  HealthStatus,
} from "@/platform/observability/types";

/**
 * Create a deterministic mock health probe.
 */
export function createMockHealthProbe(
  name = "mock",
  status: HealthStatus = "healthy"
): HealthProbe {
  return {
    name,
    async check(_timeoutMs?: number): Promise<HealthCheckResult> {
      return {
        name,
        status,
        latencyMs: 1,
        detail: "mock probe",
        checkedAt: new Date().toISOString(),
      };
    },
  };
}
