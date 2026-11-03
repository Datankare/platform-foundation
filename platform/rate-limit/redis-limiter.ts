/**
 * Redis Rate Limiter — Distributed Sliding Window.
 *
 * Uses Redis sorted sets (ZSET) for precise sliding window rate limiting.
 * Each request is a member with score = timestamp. Window pruning and
 * count check happen atomically via pipeline.
 *
 * Works with Upstash REST API (fetch-based, serverless-compatible).
 *
 * Counters are kept per tenant (ADR-053 D6): one Redis serves every tenant, so every key carries
 * the current tenant's partition and the same identifier in two tenants is two counters even
 * when a caller passes an identifier without its tenant. enforceRateLimit also puts the tenant
 * in the identifier. Outside any tenant, keys fall in the "no tenant" partition
 * (platform/tenancy/partition.ts).
 *
 * @module platform/rate-limit
 */

import type { RateLimiter, RateLimitResult, RateLimitRule } from "./types";
import { memoryPartition } from "@/platform/tenancy/partition";
import { generateId } from "@/platform/agents/utils";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  classifyHttpFailure,
  externalFailure,
} from "@/platform/observability/external-failure";

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

/** A ZCARD result: a whole number, or the limiter fails closed (never read as "under"). */
function countOf(result: unknown): number {
  if (typeof result === "number" && Number.isInteger(result) && result >= 0)
    return result;
  throw externalFailure("upstash", "bad_response", "Redis ZCARD answered no count");
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
    return `${this.namespace}${memoryPartition()}:${rule.id}:${identifier}`;
  }

  private async pipeline<T = unknown>(commands: string[][]): Promise<RedisResponse<T>[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetchWithTimeout(`${this.url}/pipeline`, {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
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
        throw externalFailure(
          "upstash",
          classifyHttpFailure(response.status, { body: text }),
          `Redis pipeline HTTP ${response.status}: ${text}`,
          { status: response.status }
        );
      }

      // TASK-197 (audit D-7): Upstash answers a failed command as an `{ error }` item inside an
      // HTTP 200. Read as a result it was undefined — `undefined > max` is false — so the
      // request was allowed: the limiter failed open. Every item must be a result.
      const items = (await response.json()) as unknown;
      if (
        !Array.isArray(items) ||
        items.length !== commands.length ||
        items.some((i) => !i || typeof i !== "object" || "error" in i || !("result" in i))
      ) {
        throw externalFailure(
          "upstash",
          "bad_response",
          "Redis pipeline answered an error item, or not one result per command"
        );
      }
      return items as RedisResponse<T>[];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async execute<T = unknown>(command: string[]): Promise<RedisResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetchWithTimeout(`${this.url}`, {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
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
        throw externalFailure(
          "upstash",
          classifyHttpFailure(response.status, { body: text }),
          `Redis HTTP ${response.status}: ${text}`,
          { status: response.status }
        );
      }

      const item = (await response.json()) as unknown;
      if (!item || typeof item !== "object" || "error" in item || !("result" in item)) {
        throw externalFailure("upstash", "bad_response", "Redis answered an error item");
      }
      return item as RedisResponse<T>;
    } finally {
      clearTimeout(timeout);
    }
  }

  async check(identifier: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const key = this.buildKey(identifier, rule);
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;
    // Crypto-secure: a member collision would drop a rate-limit entry and
    // under-count the window (bypass). See platform/agents/utils.
    const member = `${now}:${generateId()}`;

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

    const count = countOf(results[2]?.result);
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

    const count = countOf(results[1]?.result);
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
