/**
 * platform/rate-limit/store-probe.ts — readiness for an external rate-limit store
 * (TASK-197, audit D-2/D-7)
 *
 * With RATE_LIMIT_STORE=upstash and the cache elsewhere, a rotated Upstash token made every
 * rate-limited route answer 503 (the limiter fails closed) while readiness stayed green: nothing
 * probed the store. This probe asks the live limiter one read (peek: a prune and a count of a
 * probe key, nothing admitted), at most once per RATE_LIMIT_PROBE_TTL_MS. Its answer is
 * classified like any external failure: a refused token or an `{ error }` answer is unhealthy,
 * a throttled store degraded. Optional (ADR-056 D4): readiness degrades and the error reporter
 * hears of it; ADR-052 D4's alert on a failing rate-limit store reads it.
 *
 * Only the external store is probed: "postgres" is the database (its own probe), "memory" is
 * the process.
 *
 * @module platform/rate-limit
 */

import { CachedHealthProbe } from "@/platform/observability/health";
import {
  PAID_PROBE_CACHE,
  statusForReason,
} from "@/platform/observability/paid-api-probe";
import { isExternalServiceError } from "@/platform/errors/external-service";
import type { HealthCheckResult, HealthProbe } from "@/platform/observability/types";
import { getRateLimiter } from "./factory";
import type { RateLimiter, RateLimitRule } from "./types";
import { logCaught } from "@/platform/observability/caught-error";
import { logger } from "@/lib/logger";

export const RATE_LIMIT_STORE_PROBE = "rate-limit-store";
/** At most one store read per minute per instance. */
export const RATE_LIMIT_PROBE_TTL_MS = 60_000;

const PROBE_RULE: RateLimitRule = {
  id: "readiness:probe",
  maxRequests: 1,
  windowSeconds: 60,
};

export function createRateLimitStoreProbe(
  limiter: () => RateLimiter = getRateLimiter,
  options: { readonly ttlMs?: number } = {}
): HealthProbe {
  const probe: HealthProbe = {
    name: RATE_LIMIT_STORE_PROBE,
    async check(): Promise<HealthCheckResult> {
      const start = Date.now();
      const checkedAt = new Date().toISOString();
      try {
        await limiter().peek("readiness-probe", PROBE_RULE);
        return {
          name: RATE_LIMIT_STORE_PROBE,
          status: "healthy",
          latencyMs: Date.now() - start,
          detail: "the store answered",
          checkedAt,
        };
      } catch (err) {
        if (!isExternalServiceError(err))
          logCaught(
            logger,
            "Rate-limit store probe failed",
            err,
            { probe: RATE_LIMIT_STORE_PROBE },
            "warn"
          );
        return {
          name: RATE_LIMIT_STORE_PROBE,
          status: isExternalServiceError(err) ? statusForReason(err.reason) : "unhealthy",
          latencyMs: Date.now() - start,
          detail: isExternalServiceError(err)
            ? `${err.service}: ${err.reason}${err.status ? ` (HTTP ${err.status})` : ""}`
            : "the store did not answer",
          checkedAt,
        };
      }
    },
  };
  return new CachedHealthProbe(
    probe,
    options.ttlMs ?? RATE_LIMIT_PROBE_TTL_MS,
    Date.now,
    PAID_PROBE_CACHE
  );
}
