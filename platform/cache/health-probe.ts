/**
 * Redis Health Probe — wires CacheProvider health into observability.
 *
 * Bridges platform/cache health check into platform/observability
 * HealthRegistry so Redis status appears in /api/health responses.
 *
 * @module platform/cache
 * @see ADR-014 Observability Architecture — health check enrichment
 */

import type { CacheProvider } from "./types";

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
        return {
          status: "unhealthy",
          details: {
            provider: cache.name,
            error: error instanceof Error ? error.message : "Unknown error",
          },
        };
      }
    },
  };
}
