/**
 * In-Memory Rate Limiter — Sliding Window.
 *
 * Uses a sorted list of timestamps per key to implement
 * an accurate sliding window. Auto-cleans expired entries.
 *
 * NOT suitable for multi-instance production (no shared state).
 * Use RedisRateLimiter for distributed rate limiting.
 *
 * @module platform/rate-limit
 */

import type { RateLimiter, RateLimitResult, RateLimitRule } from "./types";

interface WindowEntry {
  timestamps: number[];
}

export class InMemoryRateLimiter implements RateLimiter {
  readonly name = "memory";
  private store = new Map<string, WindowEntry>();
  private readonly namespace: string;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { namespace?: string; cleanupIntervalMs?: number }) {
    this.namespace = options?.namespace ?? "rl:";

    // Periodic cleanup of expired windows
    const cleanupInterval = options?.cleanupIntervalMs ?? 60_000;
    if (cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
      // Unref so it doesn't prevent process exit
      if (
        this.cleanupTimer &&
        typeof this.cleanupTimer === "object" &&
        "unref" in this.cleanupTimer
      ) {
        (this.cleanupTimer as NodeJS.Timeout).unref();
      }
    }
  }

  private buildKey(identifier: string, rule: RateLimitRule): string {
    return `${this.namespace}${rule.id}:${identifier}`;
  }

  private getWindow(key: string): WindowEntry {
    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }
    return entry;
  }

  private pruneWindow(entry: WindowEntry, windowStart: number): void {
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
  }

  async check(identifier: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const key = this.buildKey(identifier, rule);
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;

    const entry = this.getWindow(key);
    this.pruneWindow(entry, windowStart);

    const resetAt = Math.ceil((now + rule.windowSeconds * 1000) / 1000);

    if (entry.timestamps.length >= rule.maxRequests) {
      const oldestInWindow = entry.timestamps[0] ?? now;
      const retryAfterMs = oldestInWindow + rule.windowSeconds * 1000 - now;
      return {
        allowed: false,
        limit: rule.maxRequests,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.ceil(Math.max(retryAfterMs, 0) / 1000),
      };
    }

    // Consume: add timestamp
    entry.timestamps.push(now);

    return {
      allowed: true,
      limit: rule.maxRequests,
      remaining: rule.maxRequests - entry.timestamps.length,
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  async peek(identifier: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const key = this.buildKey(identifier, rule);
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;

    const entry = this.getWindow(key);
    this.pruneWindow(entry, windowStart);

    const resetAt = Math.ceil((now + rule.windowSeconds * 1000) / 1000);
    const remaining = Math.max(0, rule.maxRequests - entry.timestamps.length);

    return {
      allowed: remaining > 0,
      limit: rule.maxRequests,
      remaining,
      resetAt,
      retryAfterSeconds: remaining > 0 ? 0 : Math.ceil(rule.windowSeconds),
    };
  }

  async reset(identifier: string, rule: RateLimitRule): Promise<void> {
    this.store.delete(this.buildKey(identifier, rule));
  }

  /** Remove expired windows */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      // If no timestamps remain after pruning with a generous window, delete
      if (
        entry.timestamps.length === 0 ||
        entry.timestamps.every((ts) => now - ts > 3600_000)
      ) {
        this.store.delete(key);
      }
    }
  }

  /** Stop the cleanup timer (for testing / shutdown) */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Test helper: get store size */
  get size(): number {
    return this.store.size;
  }
}
