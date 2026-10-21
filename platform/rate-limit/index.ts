/**
 * Rate Limiter — barrel exports and factory.
 *
 * Routes enforce a limit with one call (ADR-052):
 *   import { enforceRateLimit, DEFAULT_RULES } from "@/platform/rate-limit";
 *   const limited = await enforceRateLimit(request, DEFAULT_RULES.AI_PER_USER, { actorId });
 *   if (limited) return limited;
 *
 * The store behind the shared limiter is a provider slot (RATE_LIMIT_STORE: supabase, upstash,
 * memory), set by the provider registry; every store passes the same conformance kit.
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
export { SupabaseRateLimiter } from "./supabase-limiter";
export type { SupabaseRateLimiterConfig } from "./supabase-limiter";
export { enforceRateLimit } from "./enforce";
export type { RateLimitSubject } from "./enforce";
export { getClientIp } from "./client-ip";

export {
  createRateLimiter,
  getRateLimiter,
  setRateLimiter,
  resetRateLimiter,
} from "./factory";
export type { RateLimitStoreType } from "./factory";
