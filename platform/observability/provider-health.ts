/**
 * platform/observability/provider-health.ts — The result of probing one provider, and how a
 * connectivity failure is told apart from a provider that answered with an error.
 *
 * Shared by the provider probes of the modules (voice, song identification, audio conversion —
 * ADR-054): each probe calls its provider once and reports this shape, and a module's
 * HealthProbe adapter maps it onto HealthCheckResult. Kept in the core so two modules that probe
 * the same way do not each carry a copy.
 *
 * @module platform/observability
 */

import { logCaught } from "@/platform/observability/caught-error";
import { logger } from "@/lib/logger";

/** One provider probe's outcome. `error` is set only when the provider could not be reached. */
export interface ProviderHealthStatus {
  readonly provider: string;
  readonly healthy: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

/**
 * Network failures — the provider could not be reached. Any other error means it answered (a
 * validation error for a probe's minimal input is still a responsive provider).
 */
const CONNECTIVITY_FAILURE = /ECONNREFUSED|ENOTFOUND|timed out|fetch failed/i;

/** Whether an error message says the provider could not be reached. */
export function isConnectivityFailure(message: string): boolean {
  return CONNECTIVITY_FAILURE.test(message);
}

/** What an unreachable provider's status says; the network's own text is logged (R-77). */
export const PROVIDER_UNREACHABLE = "the provider could not be reached";

/**
 * Run a probe call and classify its outcome: success is healthy; a connectivity failure is
 * unhealthy (its message logged, the status saying PROVIDER_UNREACHABLE); any other error is a
 * provider that answered, so healthy.
 */
export async function probeResponsive(
  provider: string,
  call: () => Promise<unknown>,
  now: () => number = Date.now
): Promise<ProviderHealthStatus> {
  const start = now();
  try {
    await call();
    return { provider, healthy: true, latencyMs: now() - start };
  } catch (err) {
    if (isConnectivityFailure(err instanceof Error ? err.message : String(err))) {
      logCaught(logger, "Provider unreachable", err, { provider }, "warn");
      return {
        provider,
        healthy: false,
        latencyMs: now() - start,
        error: PROVIDER_UNREACHABLE,
      };
    }
    return { provider, healthy: true, latencyMs: now() - start, error: undefined };
  }
}
