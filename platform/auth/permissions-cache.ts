/**
 * platform/auth/permissions-cache.ts — In-memory permissions cache
 *
 * Caches resolved permissions to avoid a database round-trip on every
 * API request. TTL-based expiry with manual invalidation.
 *
 * Design:
 * - In-memory Map (no external dependency — Redis in Phase 2)
 * - TTL: 60 seconds default (configurable)
 * - Invalidation: call invalidate(cognitoSub) after role/entitlement changes
 * - Bounded: max 10,000 entries (LRU eviction when full)
 * - Keyed by tenant and subject (ADR-053 D3): a permission set resolved in one tenant is never
 *   served in another. Outside any tenant the key uses the "no tenant" partition, which no
 *   request reaches (resolution itself refuses work without a tenant).
 *
 * Sprint 3, Task 3.5
 *
 * Phase 2 decision: This module uses a module-level Map (mutable singleton).
 * In Phase 2, this will be replaced with a CacheProvider interface
 * (same pattern as AuthProvider) with InMemoryCache and RedisCache
 * implementations. The interface will be designed with Redis in hand,
 * not guessed at now. See ADR-012 for the abstraction pattern.
 */

import {
  resolvePermissions,
  type EffectivePermissions,
} from "@/platform/auth/permissions";
import { memoryPartition } from "@/platform/tenancy/partition";

interface CacheEntry {
  /** The subject, so invalidation can find every tenant's entry for it. */
  sub: string;
  data: EffectivePermissions;
  expiresAt: number;
  lastAccessed: number;
}

const DEFAULT_TTL_MS = 60_000; // 60 seconds
const MAX_ENTRIES = 10_000;

const cache = new Map<string, CacheEntry>();

/** The cache key: the current tenant's partition and the subject (NUL never occurs in either). */
function keyFor(cognitoSub: string): string {
  return `${memoryPartition()}\u0000${cognitoSub}`;
}

/**
 * Get cached permissions for a user. Resolves from DB on cache miss.
 */
export async function getCachedPermissions(
  cognitoSub: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<EffectivePermissions | null> {
  const now = Date.now();
  const key = keyFor(cognitoSub);
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    cached.lastAccessed = now;
    return cached.data;
  }

  // Cache miss or expired — resolve from DB
  const permissions = await resolvePermissions(cognitoSub);

  if (permissions) {
    evictIfFull();
    cache.set(key, {
      sub: cognitoSub,
      data: permissions,
      expiresAt: now + ttlMs,
      lastAccessed: now,
    });
  }

  return permissions;
}

/**
 * Check if a user has a specific permission (cached).
 */
export async function hasCachedPermission(
  cognitoSub: string,
  permissionCode: string
): Promise<boolean> {
  const effective = await getCachedPermissions(cognitoSub);
  if (!effective) return false;
  return effective.permissions.includes(permissionCode);
}

/**
 * Invalidate cached permissions for a user, in every tenant (over-invalidating is safe; serving
 * a stale grant is not). Call after role changes, entitlement grants/revokes.
 */
export function invalidatePermissions(cognitoSub: string): void {
  for (const [key, entry] of cache) {
    if (entry.sub === cognitoSub) cache.delete(key);
  }
}

/**
 * Clear the entire cache.
 * Useful for admin operations that affect many users.
 */
export function clearPermissionsCache(): void {
  cache.clear();
}

/**
 * Get cache statistics for monitoring.
 */
export function getCacheStats(): {
  size: number;
  maxSize: number;
  ttlMs: number;
} {
  return {
    size: cache.size,
    maxSize: MAX_ENTRIES,
    ttlMs: DEFAULT_TTL_MS,
  };
}

/**
 * Evict least-recently-accessed entry if cache is full.
 */
function evictIfFull(): void {
  if (cache.size < MAX_ENTRIES) return;

  let oldestKey: string | null = null;
  let oldestAccess = Infinity;

  for (const [key, entry] of cache.entries()) {
    if (entry.lastAccessed < oldestAccess) {
      oldestAccess = entry.lastAccessed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    cache.delete(oldestKey);
  }
}
