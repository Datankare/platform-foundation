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

/** The message of a thrown value, whatever was thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether an error message says the provider could not be reached. */
export function isConnectivityFailure(message: string): boolean {
  return CONNECTIVITY_FAILURE.test(message);
}

/**
 * Run a probe call and classify its outcome: success is healthy; a connectivity failure is
 * unhealthy and carries its message; any other error is a provider that answered, so healthy.
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
    const message = errorMessage(err);
    const unreachable = isConnectivityFailure(message);
    return {
      provider,
      healthy: !unreachable,
      latencyMs: now() - start,
      error: unreachable ? message : undefined,
    };
  }
}
