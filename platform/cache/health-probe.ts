/**
 * Redis Health Probe — wires CacheProvider health into observability.
 *
 * Bridges platform/cache health check into platform/observability
 * HealthRegistry so Redis status appears in /api/health responses.
 *
 * @module platform/cache
 * @see ADR-014 Observability Architecture — health check enrichment
 */

import type {
  HealthCheckResult,
  HealthProbe as ObservabilityHealthProbe,
} from "@/platform/observability/types";
import type { CacheProvider } from "./types";
import { PROBE_FAILED, logCaught } from "@/platform/observability/caught-error";
import { logger } from "@/lib/logger";

/**
 * Health probe interface (matches platform/observability HealthProbe).
 * Re-declared here to avoid circular dependency between cache and observability.
 */
interface HealthProbe {
  readonly name: string;
  check(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    details?: Record<string, unknown>;
  }>;
}

/**
 * Create a health probe from a CacheProvider.
 *
 * Usage:
 *   import { createCacheHealthProbe } from "@/platform/cache/health-probe";
 *   import { getCache } from "@/platform/cache";
 *   healthRegistry.register(createCacheHealthProbe(getCache()));
 */
export function createCacheHealthProbe(cache: CacheProvider): HealthProbe {
  return {
    name: `cache:${cache.name}`,
    async check() {
      try {
        const health = await cache.health();
        return {
          status: health.connected ? "healthy" : "unhealthy",
          details: {
            provider: health.provider,
            latencyMs: health.latencyMs,
            ...(health.error ? { error: health.error } : {}),
          },
        };
      } catch (error) {
        logCaught(
          logger,
          "Cache health check failed",
          error,
          { provider: cache.name },
          "warn"
        );
        return {
          status: "unhealthy",
          details: {
            provider: cache.name,
            error: PROBE_FAILED,
          },
        };
      }
    },
  };
}

/**
 * The cache as a readiness probe (ADR-056 D4): the selected cache must answer for the instance
 * to be ready. An Upstash cache is pinged; the in-memory cache is part of the process and always
 * answers. `name` is "cache" whatever the provider (the provider is not exposed), and the check
 * is bounded by the registry's timeout.
 */
export function createCacheReadinessProbe(
  cache: CacheProvider
): ObservabilityHealthProbe {
  return {
    name: "cache",
    async check(): Promise<HealthCheckResult> {
      const checkedAt = new Date().toISOString();
      try {
        const health = await cache.health();
        return {
          name: "cache",
          status: health.connected ? "healthy" : "unhealthy",
          latencyMs: health.latencyMs,
          detail: health.connected
            ? `${health.provider} answered`
            : `${health.provider}: ${health.error ?? "not connected"}`,
          checkedAt,
        };
      } catch (error) {
        logCaught(logger, "Cache health check failed", error, { probe: "cache" }, "warn");
        return {
          name: "cache",
          status: "unhealthy",
          detail: PROBE_FAILED,
          checkedAt,
        };
      }
    },
  };
}
