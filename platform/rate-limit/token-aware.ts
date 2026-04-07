/**
 * Token-Aware Rate Limiting — Extension point for AI cost control.
 *
 * GenAI Principles satisfied:
 *   P5  — AI cost tracked per user, per feature
 *   P10 — Surface placed now, not discovered in Phase 6
 *
 * Phase 2: Interface defined, not enforced.
 * Phase 6: Token budget enforcement activates.
 *
 * This extends RateLimitRule with token-budget awareness so that
 * rate limiting can consider AI token consumption, not just
 * request count. A user who makes 5 requests consuming 100K tokens
 * is more expensive than one making 20 requests consuming 1K tokens.
 *
 * @module platform/rate-limit
 * @see GENAI_ROADMAP.md Phase 6 — Token budgets
 */

import type { RateLimitResult, RateLimitRule } from "./types";

/**
 * Token budget rule — extends basic rate limit with token tracking.
 *
 * Phase 6 enforcement. Interface defined now to prevent late discovery.
 */
export interface TokenBudgetRule extends RateLimitRule {
  /** Maximum tokens (input + output) allowed in the window. 0 = unlimited. */
  maxTokensPerWindow: number;
  /** Maximum estimated cost (USD) per window. 0 = unlimited. */
  maxCostPerWindow: number;
}

/**
 * Token-aware rate limit result — extends basic result with token info.
 */
export interface TokenAwareRateLimitResult extends RateLimitResult {
  /** Tokens consumed in the current window */
  tokensUsed: number;
  /** Token budget remaining in the current window */
  tokensRemaining: number;
  /** Cost consumed in the current window (USD) */
  costUsed: number;
  /** Cost budget remaining (USD) */
  costRemaining: number;
}

/**
 * Token-aware rate limiter interface.
 *
 * Extends RateLimiter with token-budget checking.
 * Phase 6 implementation will wrap the base RateLimiter
 * and add a secondary token-budget check per request.
 */
export interface TokenAwareRateLimiter {
  /**
   * Check request AND token budget.
   * Returns combined result: both request count and token budget must pass.
   */
  checkWithTokens(
    identifier: string,
    rule: TokenBudgetRule,
    tokensConsumed: number,
    costUsd: number
  ): Promise<TokenAwareRateLimitResult>;

  /**
   * Record token consumption after an AI call completes.
   * Called by the orchestrator after each AI call.
   */
  recordTokenUsage(
    identifier: string,
    rule: TokenBudgetRule,
    tokensConsumed: number,
    costUsd: number
  ): Promise<void>;

  /**
   * Peek at current token budget usage without consuming.
   */
  peekTokenBudget(
    identifier: string,
    rule: TokenBudgetRule
  ): Promise<TokenAwareRateLimitResult>;
}

/** Pre-configured token budget rules (Phase 6 activation) */
export const TOKEN_BUDGET_RULES: Record<string, TokenBudgetRule> = {
  /** Free tier: 50K tokens/day, $0.10/day */
  FREE_TIER_DAILY: {
    id: "token:free:daily",
    maxRequests: 100,
    windowSeconds: 86400,
    maxTokensPerWindow: 50_000,
    maxCostPerWindow: 0.1,
  },
  /** Pro tier: 500K tokens/day, $1.00/day */
  PRO_TIER_DAILY: {
    id: "token:pro:daily",
    maxRequests: 1000,
    windowSeconds: 86400,
    maxTokensPerWindow: 500_000,
    maxCostPerWindow: 1.0,
  },
  /** Enterprise tier: 5M tokens/day, $10.00/day */
  ENTERPRISE_TIER_DAILY: {
    id: "token:enterprise:daily",
    maxRequests: 10000,
    windowSeconds: 86400,
    maxTokensPerWindow: 5_000_000,
    maxCostPerWindow: 10.0,
  },
};
