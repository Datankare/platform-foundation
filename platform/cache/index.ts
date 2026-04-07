/**
 * Cache Provider — barrel exports and factory.
 *
 * Usage:
 *   import { createCacheProvider } from "@/platform/cache";
 *   const cache = createCacheProvider(); // auto-detects from env
 *
 * Environment variables:
 *   UPSTASH_REDIS_REST_URL   — Redis REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN — Redis auth token
 *   CACHE_NAMESPACE          — Key prefix (default: "pf:")
 *   CACHE_DEFAULT_TTL        — Default TTL in seconds (default: 3600)
 *
 * If Redis env vars are not set, falls back to InMemoryCacheProvider.
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

/** Singleton cache instance */
let cacheInstance: CacheProvider | null = null;

/**
 * Create a cache provider from explicit config.
 * Primarily for testing or when you need a non-singleton instance.
 */
export function createCacheProvider(config?: Partial<CacheConfig>): CacheProvider {
  const provider = config?.provider ?? (getRedisUrl() ? "redis" : "memory");
  const namespace = config?.namespace ?? getEnv("CACHE_NAMESPACE", "pf:");
  const defaultTTLSeconds =
    config?.defaultTTLSeconds ?? parseInt(getEnv("CACHE_DEFAULT_TTL", "3600"), 10);

  if (provider === "redis") {
    const url = config?.redisUrl ?? getRedisUrl();
    const token = config?.redisToken ?? getRedisToken();

    if (!url || !token) {
      console.warn(
        "[cache] Redis config incomplete — falling back to in-memory cache. " +
          "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for Redis."
      );
      return new InMemoryCacheProvider({ namespace, defaultTTLSeconds });
    }

    return new RedisCacheProvider({ url, token, namespace, defaultTTLSeconds });
  }

  return new InMemoryCacheProvider({ namespace, defaultTTLSeconds });
}

/**
 * Get the singleton cache provider.
 * Auto-detects Redis from environment, falls back to in-memory.
 */
export function getCache(): CacheProvider {
  if (!cacheInstance) {
    cacheInstance = createCacheProvider();
  }
  return cacheInstance;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetCache(): void {
  cacheInstance = null;
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
