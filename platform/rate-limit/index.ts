/**
 * Rate Limiter — barrel exports and factory.
 *
 * Routes enforce a limit with one call (ADR-052):
 *   import { enforceRateLimit, DEFAULT_RULES } from "@/platform/rate-limit";
 *   const limited = await enforceRateLimit(request, DEFAULT_RULES.AI_PER_USER, { actorId });
 *   if (limited) return limited;
 *
 * The store behind the shared limiter is a provider slot (RATE_LIMIT_STORE: postgres or
 * supabase (the same Postgres store), upstash, memory), set by the provider registry; every store passes the same conformance kit.
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
export { listRateRules, getRateRule } from "./rules";

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
export { PostgresRateLimiter } from "./postgres-limiter";
export type { PostgresRateLimiterConfig } from "./postgres-limiter";
export { enforceRateLimit } from "./enforce";
export {
  DAILY_PAID_QUOTA_KEY,
  DEFAULT_DAILY_PAID_QUOTA,
  dailyPaidQuota,
  enforceDailyPaidQuota,
} from "./daily-quota";
export type { RateLimitSubject } from "./enforce";
export { getClientIp } from "./client-ip";

export {
  createRateLimiter,
  getRateLimiter,
  setRateLimiter,
  resetRateLimiter,
} from "./factory";
export type { RateLimitStoreType } from "./factory";
