/**
 * platform/realtime/service-probe.ts — is the realtime service reachable from this server?
 * (ADR-056 D4)
 *
 * Realtime connections are the browser's (./health-probe.ts measures one client's link); what a
 * server can know is whether the selected service answers at all. With REALTIME_PROVIDER=supabase
 * this asks Supabase's realtime endpoint once: any HTTP answer — even an error status for a bare
 * request — means it is reachable; no answer within the timeout means it is not. The mock
 * provider has no service to reach and is reported healthy, saying so.
 *
 * Registered as an optional probe: unreachable realtime degrades /api/health/ready, it never
 * makes an instance unready. The detail (an address, a network error) goes to the error reporter
 * only; the routes return names and statuses.
 *
 * @module platform/realtime
 */

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import type { HealthCheckResult, HealthProbe } from "@/platform/observability/types";

export function createRealtimeServiceProbe(
  selection: string,
  supabaseUrl: string | undefined,
  fetchImpl: typeof fetchWithTimeout = fetchWithTimeout
): HealthProbe {
  return {
    name: "realtime",
    async check(timeoutMs = 3_000): Promise<HealthCheckResult> {
      const checkedAt = () => new Date().toISOString();
      if (selection !== "supabase") {
        return {
          name: "realtime",
          status: "healthy",
          detail: `No realtime service to reach (REALTIME_PROVIDER=${selection})`,
          checkedAt: checkedAt(),
        };
      }
      if (!supabaseUrl) {
        return {
          name: "realtime",
          status: "unhealthy",
          detail: "REALTIME_PROVIDER=supabase but SUPABASE_URL is not set",
          checkedAt: checkedAt(),
        };
      }
      const start = Date.now();
      try {
        const res = await fetchImpl(`${supabaseUrl.replace(/\/+$/, "")}/realtime/v1/`, {
          method: "GET",
          timeoutMs,
          maxRetries: 0,
        });
        return {
          name: "realtime",
          status: "healthy",
          latencyMs: Date.now() - start,
          detail: `Realtime endpoint reachable (HTTP ${res.status})`,
          checkedAt: checkedAt(),
        };
      } catch (err) {
        return {
          name: "realtime",
          status: "unhealthy",
          latencyMs: Date.now() - start,
          detail: err instanceof Error ? err.message : String(err),
          checkedAt: checkedAt(),
        };
      }
    },
  };
}
