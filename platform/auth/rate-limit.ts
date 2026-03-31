/**
 * platform/auth/rate-limit.ts — Per-IP rate limiting
 *
 * In-memory sliding window rate limiter. Tracks request counts
 * per IP address within a configurable time window.
 *
 * Design:
 * - In-memory Map (no external dependency — Redis in Phase 2)
 * - Sliding window: requests counted within windowMs
 * - Configurable per-route limits
 * - Automatic cleanup of expired entries
 *
 * Phase 2: Replace with Redis-backed limiter for multi-instance.
 * Same CacheProvider abstraction as permissions-cache.
 *
 * Sprint 6, Task 6.8
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitEntry {
  timestamps: number[];
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000, // 1 minute
  maxRequests: 60, // 60 requests per minute
};

const store = new Map<string, RateLimitEntry>();

let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Extract client IP from the request.
 * Checks x-forwarded-for (Vercel/proxy) then falls back to
 * x-real-ip, then "unknown".
 */
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}

/**
 * Clean up expired entries from the store.
 * Runs at most once per CLEANUP_INTERVAL_MS.
 */
function cleanupExpired(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;

  lastCleanup = now;
  const cutoff = now - windowMs;

  for (const [ip, entry] of store.entries()) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) {
      store.delete(ip);
    }
  }
}

/**
 * Check rate limit for a request. Returns 429 if exceeded.
 *
 * Usage in API routes:
 *   const limited = checkRateLimit(request);
 *   if (limited) return limited;
 */
export function checkRateLimit(
  request: NextRequest,
  config: RateLimitConfig = DEFAULT_CONFIG
): NextResponse | null {
  const ip = getClientIp(request);
  const now = Date.now();
  const cutoff = now - config.windowMs;

  cleanupExpired(config.windowMs);

  const entry = store.get(ip) || { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= config.maxRequests) {
    logger.warn("Rate limit exceeded", {
      ip,
      requestCount: entry.timestamps.length,
      windowMs: config.windowMs,
      route: request.nextUrl.pathname,
    });

    const retryAfterSeconds = Math.ceil(config.windowMs / 1000);

    return NextResponse.json(
      { error: "Too many requests", retryAfter: retryAfterSeconds },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds),
          "X-RateLimit-Limit": String(config.maxRequests),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil((cutoff + config.windowMs) / 1000)),
        },
      }
    );
  }

  entry.timestamps.push(now);
  store.set(ip, entry);

  return null;
}

/**
 * Get current rate limit status for an IP (for response headers).
 */
export function getRateLimitStatus(
  ip: string,
  config: RateLimitConfig = DEFAULT_CONFIG
): { remaining: number; limit: number; resetAt: number } {
  const now = Date.now();
  const cutoff = now - config.windowMs;
  const entry = store.get(ip);
  const count = entry ? entry.timestamps.filter((t) => t > cutoff).length : 0;

  return {
    remaining: Math.max(0, config.maxRequests - count),
    limit: config.maxRequests,
    resetAt: Math.ceil((now + config.windowMs) / 1000),
  };
}

/**
 * Clear the rate limit store. For testing.
 */
export function clearRateLimitStore(): void {
  store.clear();
}

/**
 * Get store size. For monitoring.
 */
export function getRateLimitStoreSize(): number {
  return store.size;
}
