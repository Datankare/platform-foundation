/**
 * Rate Limiter — Generic rate limiting abstraction.
 *
 * Supports sliding window algorithm for accurate rate limiting.
 * Interface-first: swap between in-memory (dev) and Redis (production)
 * via configuration.
 *
 * @module platform/rate-limit
 * @see ROADMAP.md Phase 2 Sprint 4 — rate limiter upgrade
 */

/** Result of a rate limit check */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Total requests allowed in the window */
  limit: number;
  /** Remaining requests in the current window */
  remaining: number;
  /** When the current window resets (Unix timestamp in seconds) */
  resetAt: number;
  /** Retry-After value in seconds (0 if allowed) */
  retryAfterSeconds: number;
}

/** Configuration for a rate limit rule */
export interface RateLimitRule {
  /** Rule identifier (e.g., "api:global", "ai:per-user") */
  id: string;
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Window size in seconds */
  windowSeconds: number;
}

/** Rate limiter configuration */
export interface RateLimitConfig {
  /** Backend type: "redis" | "memory" */
  provider: "redis" | "memory";
  /** Key prefix for rate limit counters. Default: "rl:" */
  namespace?: string;
}

/**
 * Rate limiter interface.
 *
 * Implementations track request counts per identifier within
 * sliding time windows. Thread-safe in single-process (memory)
 * and distributed (Redis) environments.
 */
export interface RateLimiter {
  /** Provider name */
  readonly name: string;

  /**
   * Check and consume one request against the rate limit.
   *
   * @param identifier — Unique caller ID (user ID, IP, API key)
   * @param rule — The rate limit rule to apply
   * @returns Whether the request is allowed, with remaining quota info
   */
  check(identifier: string, rule: RateLimitRule): Promise<RateLimitResult>;

  /**
   * Check without consuming — peek at current usage.
   */
  peek(identifier: string, rule: RateLimitRule): Promise<RateLimitResult>;

  /**
   * Reset rate limit for an identifier + rule combination.
   */
  reset(identifier: string, rule: RateLimitRule): Promise<void>;
}

/** Pre-configured rate limit rules for common use cases */
export const DEFAULT_RULES: Record<string, RateLimitRule> = {
  /** Global API rate limit: 100 requests per minute */
  API_GLOBAL: { id: "api:global", maxRequests: 100, windowSeconds: 60 },
  /** AI endpoint: 20 requests per minute per user */
  AI_PER_USER: { id: "ai:per-user", maxRequests: 20, windowSeconds: 60 },
  /** Auth endpoints: 10 attempts per 15 minutes */
  AUTH_LOGIN: { id: "auth:login", maxRequests: 10, windowSeconds: 900 },
  /** Admin operations: 30 per minute */
  ADMIN_OPS: { id: "admin:ops", maxRequests: 30, windowSeconds: 60 },
  /** Song identification: 10 per hour per user */
  SONG_IDENTIFY: { id: "song:identify", maxRequests: 10, windowSeconds: 3600 },
};
