/**
 * Cache Provider — Generic caching abstraction.
 *
 * Interface-first design: consumers code against CacheProvider,
 * implementations are swappable via configuration.
 *
 * Implementations:
 * - InMemoryCacheProvider (dev/test fallback)
 * - RedisCacheProvider (Upstash, Redis Cloud, or any Redis)
 *
 * @module platform/cache
 * @see ADR-015 GenAI-Native Stack (cache layer)
 * @see ROADMAP.md Phase 2 Sprint 4
 */

/** Time-to-live options for cache entries */
export interface CacheTTLOptions {
  /** TTL in seconds. Undefined = no expiry. */
  ttlSeconds?: number;
}

/** Options for cache get operations */
export interface CacheGetOptions {
  /** If true, resets TTL on access (sliding expiry). Default: false. */
  slidingExpiry?: boolean;
}

/** Options for cache set operations */
export interface CacheSetOptions extends CacheTTLOptions {
  /** If true, only set if key does NOT exist (NX). Default: false. */
  onlyIfAbsent?: boolean;
}

/** A single cache entry with metadata */
export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  /** When the entry was created (ISO string) */
  createdAt: string;
  /** When the entry expires (ISO string), or null if no TTL */
  expiresAt: string | null;
}

/** Cache provider health status */
export interface CacheHealthStatus {
  connected: boolean;
  latencyMs: number;
  provider: string;
  error?: string;
}

/**
 * Generic cache provider interface.
 *
 * All implementations must be:
 * - Async (network-backed providers like Redis)
 * - Namespace-aware (prefix keys to avoid collisions)
 * - TTL-capable (entries auto-expire)
 * - Serialization-transparent (JSON in/out)
 */
export interface CacheProvider {
  /** Provider identifier (e.g., "redis", "memory") */
  readonly name: string;

  /** Get a cached value by key. Returns null if not found or expired. */
  get<T = unknown>(key: string, options?: CacheGetOptions): Promise<T | null>;

  /** Set a cached value. Overwrites if key exists (unless onlyIfAbsent). */
  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void>;

  /** Delete a cached key. Returns true if key existed. */
  delete(key: string): Promise<boolean>;

  /** Check if key exists (without fetching value). */
  has(key: string): Promise<boolean>;

  /** Clear all keys under this provider's namespace. */
  clear(): Promise<void>;

  /** Health check — verify connectivity and measure latency. */
  health(): Promise<CacheHealthStatus>;
}

/** Factory configuration for cache providers */
export interface CacheConfig {
  /** Provider type: "redis" | "memory" */
  provider: "redis" | "memory";
  /** Key prefix/namespace. Default: "pf:" */
  namespace?: string;
  /** Default TTL in seconds for all entries. Default: 3600 (1 hour). */
  defaultTTLSeconds?: number;
  /** Redis connection URL (required for provider: "redis"). */
  redisUrl?: string;
  /** Redis auth token (required for Upstash). */
  redisToken?: string;
}
