/**
 * Rate Limiter — barrel exports and factory.
 *
 * Usage:
 *   import { getRateLimiter, DEFAULT_RULES } from "@/platform/rate-limit";
 *   const limiter = getRateLimiter();
 *   const result = await limiter.check(userId, DEFAULT_RULES.AI_PER_USER);
 *   if (!result.allowed) { return res.status(429)... }
 *
 * @module platform/rate-limit
 */

export type {
  RateLimitConfig,
  RateLimiter,
  RateLimitResult,
  RateLimitRule,
} from "./types";
export { DEFAULT_RULES } from "./types";

// Token-aware extension (GenAI Principle P5: cost tracking, P10: no late discovery)
export type {
  TokenBudgetRule,
  TokenAwareRateLimitResult,
  TokenAwareRateLimiter,
} from "./token-aware";
export { TOKEN_BUDGET_RULES } from "./token-aware";

export { InMemoryRateLimiter } from "./memory-limiter";
export { RedisRateLimiter } from "./redis-limiter";
export type { RedisRateLimiterConfig } from "./redis-limiter";

import { InMemoryRateLimiter } from "./memory-limiter";
import { RedisRateLimiter } from "./redis-limiter";
import type { RateLimiter } from "./types";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

/** Singleton rate limiter instance */
/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const LIMITER_KEY = "platform.rateLimit.limiter";
function readLimiterInstance(): RateLimiter | null {
  return getSingleton<RateLimiter | null>(LIMITER_KEY, () => null);
}
function writeLimiterInstance(next: RateLimiter | null): void {
  setSingleton<RateLimiter | null>(LIMITER_KEY, next);
}

/**
 * Create a rate limiter from environment config.
 * Redis if UPSTASH_REDIS_REST_URL is set, otherwise in-memory.
 */
export function createRateLimiter(config?: {
  provider?: "redis" | "memory";
  namespace?: string;
}): RateLimiter {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const provider = config?.provider ?? (redisUrl ? "redis" : "memory");
  const namespace = config?.namespace ?? "rl:";

  if (provider === "redis" && redisUrl && redisToken) {
    return new RedisRateLimiter({ url: redisUrl, token: redisToken, namespace });
  }

  if (provider === "redis") {
    console.warn(
      "[rate-limit] Redis config incomplete — falling back to in-memory limiter. " +
        "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for distributed rate limiting."
    );
  }

  return new InMemoryRateLimiter({ namespace, cleanupIntervalMs: 0 });
}

/** Get the singleton rate limiter. */
export function getRateLimiter(): RateLimiter {
  const existing = readLimiterInstance();
  if (existing) return existing;
  const created = createRateLimiter();
  writeLimiterInstance(created);
  return created;
}

/** Reset the singleton (for testing only). */
export function resetRateLimiter(): void {
  // Three reads became one: the second `in` check could not be narrowed by the first, and
  // each call is a registry lookup.
  const existing = readLimiterInstance();
  if (existing && "destroy" in existing) {
    (existing as InMemoryRateLimiter).destroy();
  }
  writeLimiterInstance(null);
}
