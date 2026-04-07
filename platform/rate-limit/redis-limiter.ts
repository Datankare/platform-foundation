/**
 * Redis Rate Limiter — Distributed Sliding Window.
 *
 * Uses Redis sorted sets (ZSET) for precise sliding window rate limiting.
 * Each request is a member with score = timestamp. Window pruning and
 * count check happen atomically via pipeline.
 *
 * Works with Upstash REST API (fetch-based, serverless-compatible).
 *
 * @module platform/rate-limit
 */

import type { RateLimiter, RateLimitResult, RateLimitRule } from "./types";

interface RedisResponse<T = unknown> {
  result: T;
  error?: string;
}

export interface RedisRateLimiterConfig {
  /** Upstash Redis REST URL */
  url: string;
  /** Upstash Redis REST token */
  token: string;
  /** Key namespace prefix. Default: "rl:" */
  namespace?: string;
  /** Request timeout in ms. Default: 5000 */
  timeoutMs?: number;
}

export class RedisRateLimiter implements RateLimiter {
  readonly name = "redis";
  private readonly url: string;
  private readonly token: string;
  private readonly namespace: string;
  private readonly timeoutMs: number;

  constructor(config: RedisRateLimiterConfig) {
    if (!config.url || !config.token) {
      throw new Error(
        "RedisRateLimiter requires url and token. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
      );
    }
    this.url = config.url.replace(/\/$/, "");
    this.token = config.token;
    this.namespace = config.namespace ?? "rl:";
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  private buildKey(identifier: string, rule: RateLimitRule): string {
    return `${this.namespace}${rule.id}:${identifier}`;
  }

  private async pipeline<T = unknown>(commands: string[][]): Promise<RedisResponse<T>[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(commands),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        throw new Error(`Redis pipeline HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as RedisResponse<T>[];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async execute<T = unknown>(command: string[]): Promise<RedisResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        throw new Error(`Redis HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as RedisResponse<T>;
    } finally {
      clearTimeout(timeout);
    }
  }

  async check(identifier: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const key = this.buildKey(identifier, rule);
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

    // Atomic pipeline:
    // 1. Remove expired entries (before window start)
    // 2. Add current request
    // 3. Count entries in window
    // 4. Set key TTL (auto-cleanup)
    const results = await this.pipeline([
      ["ZREMRANGEBYSCORE", key, "0", String(windowStart)],
      ["ZADD", key, String(now), member],
      ["ZCARD", key],
      ["EXPIRE", key, String(rule.windowSeconds)],
    ]);

    const count = results[2]?.result as number;
    const resetAt = Math.ceil((now + rule.windowSeconds * 1000) / 1000);

    if (count > rule.maxRequests) {
      // Over limit — remove the entry we just added
      await this.execute(["ZREM", key, member]);

      return {
        allowed: false,
        limit: rule.maxRequests,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.ceil(rule.windowSeconds),
      };
    }

    return {
      allowed: true,
      limit: rule.maxRequests,
      remaining: rule.maxRequests - count,
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  async peek(identifier: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const key = this.buildKey(identifier, rule);
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;

    // Read-only: prune + count without adding
    const results = await this.pipeline([
      ["ZREMRANGEBYSCORE", key, "0", String(windowStart)],
      ["ZCARD", key],
    ]);

    const count = results[1]?.result as number;
    const remaining = Math.max(0, rule.maxRequests - count);
    const resetAt = Math.ceil((now + rule.windowSeconds * 1000) / 1000);

    return {
      allowed: remaining > 0,
      limit: rule.maxRequests,
      remaining,
      resetAt,
      retryAfterSeconds: remaining > 0 ? 0 : Math.ceil(rule.windowSeconds),
    };
  }

  async reset(identifier: string, rule: RateLimitRule): Promise<void> {
    await this.execute(["DEL", this.buildKey(identifier, rule)]);
  }
}
