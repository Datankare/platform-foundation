/**
 * platform/rate-limit/factory.ts — the shared limiter instance and the store factory (ADR-052)
 *
 * @module platform/rate-limit
 */

import { InMemoryRateLimiter } from "./memory-limiter";
import { RedisRateLimiter } from "./redis-limiter";
import { PostgresRateLimiter } from "./postgres-limiter";
import type { RateLimiter } from "./types";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { getRateLimitStoreSetting } from "@/platform/providers/environment-contract";
import { hasDatabase } from "@/platform/data";

/**
 * Where the shared counters live (ADR-052). "postgres" and "supabase" are the same store — the
 * Postgres limiter reached through platform/data (ADR-053 D4).
 */
export type RateLimitStoreType = "postgres" | "supabase" | "upstash" | "memory";

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const LIMITER_KEY = "platform.rateLimit.limiter";
function readLimiterInstance(): RateLimiter | null {
  return getSingleton<RateLimiter | null>(LIMITER_KEY, () => null);
}
function writeLimiterInstance(next: RateLimiter | null): void {
  setSingleton<RateLimiter | null>(LIMITER_KEY, next);
}

/**
 * Create a rate limiter for a store (default: RATE_LIMIT_STORE, else "memory").
 *
 * A selected shared store with missing credentials (or, for postgres/supabase, no database)
 * throws: falling back to a per-instance counter would silently stop the limit from holding
 * across instances (ADR-052 D3).
 */
export function createRateLimiter(config?: {
  provider?: RateLimitStoreType;
  namespace?: string;
}): RateLimiter {
  const provider =
    config?.provider ??
    (getRateLimitStoreSetting() as RateLimitStoreType | undefined) ??
    "memory";
  const namespace = config?.namespace ?? "rl:";

  switch (provider) {
    case "postgres":
    case "supabase": {
      if (!hasDatabase()) {
        throw new Error(
          `RATE_LIMIT_STORE=${provider} but DATABASE_URL is not set. ` +
            "Refusing to fall back to a per-instance rate limiter."
        );
      }
      return new PostgresRateLimiter({ namespace });
    }
    case "upstash": {
      const url = process.env.UPSTASH_REDIS_REST_URL ?? "";
      const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
      if (!url || !token) {
        throw new Error(
          "RATE_LIMIT_STORE=upstash but UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing. " +
            "Refusing to fall back to a per-instance rate limiter."
        );
      }
      return new RedisRateLimiter({ url, token, namespace });
    }
    case "memory":
      return new InMemoryRateLimiter({ namespace, cleanupIntervalMs: 0 });
    default:
      throw new Error(
        `RATE_LIMIT_STORE="${String(provider)}" is not a rate-limit store (postgres, supabase, upstash, memory).`
      );
  }
}

/**
 * Get the shared rate limiter. The provider registry installs it at boot; if a request arrives
 * first, it is created from the same setting (RATE_LIMIT_STORE), never a different store.
 */
export function getRateLimiter(): RateLimiter {
  const existing = readLimiterInstance();
  if (existing) return existing;
  const created = createRateLimiter();
  writeLimiterInstance(created);
  return created;
}

/** The installed limiter, if any (for the registry's idempotent init). */
export function peekRateLimiter(): RateLimiter | null {
  return readLimiterInstance();
}

/** The `name` a limiter of each store reports. */
export const RATE_LIMITER_NAMES: Readonly<Record<RateLimitStoreType, string>> = {
  postgres: "postgres",
  supabase: "postgres",
  upstash: "redis",
  memory: "memory",
};

/** Install the shared rate limiter (the provider registry does this at boot). */
export function setRateLimiter(limiter: RateLimiter): void {
  writeLimiterInstance(limiter);
}

/** Reset the singleton (for testing only). */
export function resetRateLimiter(): void {
  const existing = readLimiterInstance();
  if (existing && "destroy" in existing) {
    (existing as InMemoryRateLimiter).destroy();
  }
  writeLimiterInstance(null);
}
