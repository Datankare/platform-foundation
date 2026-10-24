/**
 * Postgres Rate Limiter — exact sliding window in the database (ADR-052, ADR-053 D4).
 *
 * Each check is one call to `rate_limit_hit` (migration 039), which serialises callers per
 * bucket with an advisory lock and uses the database clock, so every application instance sees
 * the same count and concurrent requests can never admit more than the limit.
 *
 * The functions run as the caller (security invoker) inside the current tenant's transaction,
 * so `rate_limit_events` is read and written under row-level security: the same bucket name in
 * two tenants is two counters, and with no tenant the check throws (TenantContextError) — which
 * enforceRateLimit turns into a refusal (fail closed, ADR-052 D4).
 *
 * Calls are never retried underneath: a retried check could count one request twice.
 *
 * @module platform/rate-limit
 */

import type { RateLimiter, RateLimitResult, RateLimitRule } from "./types";
import { withTenantTx } from "@/platform/data";

export interface PostgresRateLimiterConfig {
  /** Key namespace prefix. Default: "rl:" */
  namespace?: string;
}

interface HitRow {
  allowed: boolean;
  used: number;
  retry_after_seconds: number;
  /** bigint: pg returns it as a string. */
  reset_at: string | number;
}

export class PostgresRateLimiter implements RateLimiter {
  readonly name = "postgres";
  private readonly namespace: string;

  constructor(config: PostgresRateLimiterConfig = {}) {
    this.namespace = config.namespace ?? "rl:";
  }

  private bucket(identifier: string, rule: RateLimitRule): string {
    return `${this.namespace}${rule.id}:${identifier}`;
  }

  private async hit(
    identifier: string,
    rule: RateLimitRule,
    consume: boolean
  ): Promise<RateLimitResult> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<HitRow>(
        "select allowed, used, retry_after_seconds, reset_at from rate_limit_hit($1::text, $2::integer, $3::integer, $4::boolean)",
        [this.bucket(identifier, rule), rule.maxRequests, rule.windowSeconds, consume]
      )
    );
    const row = rows[0];
    if (!row || typeof row.allowed !== "boolean") {
      throw new Error("rate limit rate_limit_hit returned no row");
    }
    const used = Number(row.used) || 0;
    return {
      allowed: row.allowed,
      limit: rule.maxRequests,
      remaining: Math.max(0, rule.maxRequests - used),
      resetAt: Number(row.reset_at),
      retryAfterSeconds: row.allowed
        ? 0
        : Math.max(1, Number(row.retry_after_seconds) || 1),
    };
  }

  check(identifier: string, rule: RateLimitRule): Promise<RateLimitResult> {
    return this.hit(identifier, rule, true);
  }

  peek(identifier: string, rule: RateLimitRule): Promise<RateLimitResult> {
    return this.hit(identifier, rule, false);
  }

  async reset(identifier: string, rule: RateLimitRule): Promise<void> {
    await withTenantTx((tx) =>
      tx.query("select rate_limit_reset($1::text)", [this.bucket(identifier, rule)])
    );
  }
}
