/**
 * Supabase (Postgres) Rate Limiter — exact sliding window in the database (ADR-052).
 *
 * Each check is one call to `rate_limit_hit` (migration 039), which serialises callers per
 * bucket with an advisory lock and uses the database clock, so every application instance sees
 * the same count and concurrent requests can never admit more than the limit.
 *
 * Calls are never retried underneath: a retried check could count one request twice.
 *
 * @module platform/rate-limit
 */

import type { RateLimiter, RateLimitResult, RateLimitRule } from "./types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

export interface SupabaseRateLimiterConfig {
  /** Supabase project URL */
  url: string;
  /** Service-role key (the limiter's table is service-role only) */
  serviceKey: string;
  /** Key namespace prefix. Default: "rl:" */
  namespace?: string;
  /** Request timeout in ms. Default: 5000 */
  timeoutMs?: number;
}

interface HitRow {
  allowed: boolean;
  used: number;
  retry_after_seconds: number;
  reset_at: number | string;
}

export class SupabaseRateLimiter implements RateLimiter {
  readonly name = "supabase";
  private readonly url: string;
  private readonly key: string;
  private readonly namespace: string;
  private readonly timeoutMs: number;

  constructor(config: SupabaseRateLimiterConfig) {
    if (!config.url || !config.serviceKey) {
      throw new Error(
        "SupabaseRateLimiter requires the Supabase URL and service-role key " +
          "(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)."
      );
    }
    this.url = config.url.replace(/\/+$/, "");
    this.key = config.serviceKey;
    this.namespace = config.namespace ?? "rl:";
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  private bucket(identifier: string, rule: RateLimitRule): string {
    return `${this.namespace}${rule.id}:${identifier}`;
  }

  private async rpc(fn: string, body: Record<string, unknown>): Promise<Response> {
    const res = await fetchWithTimeout(`${this.url}/rest/v1/rpc/${fn}`, {
      timeoutMs: this.timeoutMs,
      maxRetries: 0,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`rate limit ${fn} failed (${res.status}): ${await res.text()}`);
    }
    return res;
  }

  private async hit(
    identifier: string,
    rule: RateLimitRule,
    consume: boolean
  ): Promise<RateLimitResult> {
    const res = await this.rpc("rate_limit_hit", {
      p_bucket: this.bucket(identifier, rule),
      p_limit: rule.maxRequests,
      p_window_seconds: rule.windowSeconds,
      p_consume: consume,
    });
    const payload = (await res.json()) as HitRow[] | HitRow;
    const row = Array.isArray(payload) ? payload[0] : payload;
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
    await this.rpc("rate_limit_reset", { p_bucket: this.bucket(identifier, rule) });
  }
}
