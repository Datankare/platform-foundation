/**
 * Cache Provider — barrel exports and factory.
 *
 * Usage:
 *   import { createCacheProvider } from "@/platform/cache";
 *   const cache = createCacheProvider(); // auto-detects from env
 *
 * Environment variables:
 *   CACHE_PROVIDER           — upstash | memory (TASK-139: chosen, never inferred; production
 *                              requires it — environment contract)
 *   UPSTASH_REDIS_REST_URL   — Redis REST endpoint (with CACHE_PROVIDER=upstash)
 *   UPSTASH_REDIS_REST_TOKEN — Redis auth token (with CACHE_PROVIDER=upstash)
 *   CACHE_NAMESPACE          — Key prefix (default: "pf:")
 *   CACHE_DEFAULT_TTL        — Default TTL in seconds (default: 3600)
 *
 * Unset CACHE_PROVIDER means the in-memory cache (tests, local). Redis selected without its
 * credentials throws: an explicit choice is never quietly replaced by another.
 *
 * @module platform/cache
 */

export type {
  CacheConfig,
  CacheEntry,
  CacheGetOptions,
  CacheHealthStatus,
  CacheProvider,
  CacheSetOptions,
  CacheTTLOptions,
} from "./types";

export { InMemoryCacheProvider } from "./memory-cache";
export { RedisCacheProvider } from "./redis-cache";
export type { RedisCacheConfig } from "./redis-cache";
export { createCacheHealthProbe } from "./health-probe";

// AI-specific cache (GenAI Principle P4: cached AI responses)
export { AICache, buildAICacheKey, getAICache, resetAICache } from "./ai-cache";
export type { AICacheConfig, AICacheMetricsCallback } from "./ai-cache";

import { InMemoryCacheProvider } from "./memory-cache";
import { RedisCacheProvider } from "./redis-cache";
import type { CacheConfig, CacheProvider } from "./types";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { getCacheProviderSetting } from "@/platform/providers/environment-contract";

/** Singleton cache instance */
/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const PROVIDER_KEY = "platform.cache.provider";
function readCacheInstance(): CacheProvider | null {
  return getSingleton<CacheProvider | null>(PROVIDER_KEY, () => null);
}
function writeCacheInstance(next: CacheProvider | null): void {
  setSingleton<CacheProvider | null>(PROVIDER_KEY, next);
}

/**
 * Create a cache provider from explicit config.
 * Primarily for testing or when you need a non-singleton instance.
 */
export function createCacheProvider(config?: Partial<CacheConfig>): CacheProvider {
  const provider =
    config?.provider ?? (getCacheProviderSetting() === "upstash" ? "redis" : "memory");
  const namespace = config?.namespace ?? getEnv("CACHE_NAMESPACE", "pf:");
  const defaultTTLSeconds =
    config?.defaultTTLSeconds ?? parseInt(getEnv("CACHE_DEFAULT_TTL", "3600"), 10);

  if (provider === "redis") {
    const url = config?.redisUrl ?? getRedisUrl();
    const token = config?.redisToken ?? getRedisToken();

    if (!url || !token) {
      // Fail closed (TASK-139): a chosen Redis cache missing its credentials is a
      // misconfiguration, not a reason to become a per-instance cache without saying so.
      throw new Error(
        "CACHE_PROVIDER=upstash but UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not set"
      );
    }

    return new RedisCacheProvider({ url, token, namespace, defaultTTLSeconds });
  }

  return new InMemoryCacheProvider({ namespace, defaultTTLSeconds });
}

/**
 * Get the singleton cache provider — the one CACHE_PROVIDER selects.
 */
export function getCache(): CacheProvider {
  const existing = readCacheInstance();
  if (existing) return existing;
  const created = createCacheProvider();
  writeCacheInstance(created);
  return created;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetCache(): void {
  writeCacheInstance(null);
}

function getRedisUrl(): string | undefined {
  return process.env.UPSTASH_REDIS_REST_URL;
}

function getRedisToken(): string | undefined {
  return process.env.UPSTASH_REDIS_REST_TOKEN;
}

function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}
