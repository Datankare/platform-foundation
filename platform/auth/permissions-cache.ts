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
 * Across instances (audit RR-9): an invalidation is also published to the shared cache (the
 * one CACHE_PROVIDER selects — Upstash in production) as a new version stamp for the subject, or
 * for everyone (clearPermissionsCache). An entry remembers the stamps it was resolved under and
 * is served only while they are unchanged, so a demotion takes effect on every instance at its
 * next request, not up to 60 seconds later — with no comparison of clocks between instances.
 * When the stamps cannot be read the entry is not trusted: permissions are resolved again.
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
  publishTokenRevocation,
  revokeTokenVerification,
  type PublishOutcome,
} from "@/platform/auth/token-verification";
import {
  resolvePermissions,
  type EffectivePermissions,
} from "@/platform/auth/permissions";
import { memoryPartition } from "@/platform/tenancy/partition";
import { getCache } from "@/platform/cache";
import { readStamp } from "@/platform/cache/stamp-reader";
import { inTransaction, onCommit } from "@/platform/data";
import { logger } from "@/lib/logger";
import { randomUUID } from "node:crypto";

interface CacheEntry {
  /** The subject, so invalidation can find every tenant's entry for it. */
  sub: string;
  data: EffectivePermissions;
  /** The shared invalidation stamps read before resolving; undefined when unreadable. */
  stamps: string | undefined;
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

const STAMP_ALL = "permissions:invalidated:all";
const stampFor = (cognitoSub: string) => `permissions:invalidated:${cognitoSub}`;
/** How long a stamp is kept: longer than any entry lives. */
const STAMP_TTL_SECONDS = 600;

/** The current invalidation stamps for `cognitoSub`, or undefined when they cannot be read. */
async function currentStamps(cognitoSub: string): Promise<string | undefined> {
  // Bounded and breaker-guarded (review 13 M2): a hanging shared cache never holds a permission
  // check; unreadable stamps mean the permissions are resolved from the database.
  const read = await readStamp(async () => {
    const cache = getCache();
    const [one, all] = await Promise.all([
      cache.get<string>(stampFor(cognitoSub)),
      cache.get<string>(STAMP_ALL),
    ]);
    return `${one ?? "-"}|${all ?? "-"}`;
  });
  return read.ok ? read.value : undefined;
}

/** Publish an invalidation to every instance. A failure is logged; the entry TTL still bounds it. */
async function publishStamp(key: string): Promise<void> {
  // After the caller's transaction commits, if it is in one (review 13 L5): published before, an
  // instance would re-resolve the permissions as they were and cache them under the new stamp.
  // Also when the commit's outcome is unknown (review 14 L-2): an invalidation is idempotent.
  if (
    typeof inTransaction === "function" &&
    inTransaction() &&
    typeof onCommit === "function" &&
    onCommit(
      async () => {
        await publishStampNow(key);
      },
      { idempotent: true }
    )
  ) {
    return;
  }
  await publishStampNow(key);
}

async function publishStampNow(key: string): Promise<PublishOutcome> {
  try {
    await getCache().set(key, randomUUID(), { ttlSeconds: STAMP_TTL_SECONDS });
    return { published: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("Permissions invalidation not published to other instances", {
      error,
      route: "platform/auth/permissions-cache",
    });
    return { published: false, error };
  }
}

/**
 * Get cached permissions for a user. Resolves from DB on cache miss, or when another instance
 * invalidated them since they were cached (RR-9).
 */
export async function getCachedPermissions(
  cognitoSub: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<EffectivePermissions | null> {
  const now = Date.now();
  const key = keyFor(cognitoSub);
  const cached = cache.get(key);

  const stamps = await currentStamps(cognitoSub);
  if (
    cached &&
    cached.expiresAt > now &&
    stamps !== undefined &&
    cached.stamps === stamps
  ) {
    cached.lastAccessed = now;
    return cached.data;
  }

  // Cache miss, expired, or invalidated somewhere — resolve from DB. The stamps were read
  // first: an invalidation published while this runs makes the entry stale at once.
  const permissions = await resolvePermissions(cognitoSub);

  if (permissions) {
    evictIfFull();
    cache.set(key, {
      sub: cognitoSub,
      data: permissions,
      stamps,
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
 * a stale grant is not), on this instance at once and on every other through the shared stamp.
 * Call after role changes, entitlement grants/revokes.
 */
export async function invalidatePermissions(cognitoSub: string): Promise<void> {
  for (const [key, entry] of cache) {
    if (entry.sub === cognitoSub) cache.delete(key);
  }
  await publishStamp(stampFor(cognitoSub));
  // What changed the user's permissions (a role, an entitlement, the account's deletion) also
  // voids their remembered token verifications, so nothing about them is served from before.
  await revokeTokenVerification(cognitoSub);
}

/** What publishInvalidation reached: the permissions stamp, and the token revocation stamp. */
export interface InvalidationOutcome {
  readonly permissions: PublishOutcome;
  readonly tokens: PublishOutcome;
}

/**
 * invalidatePermissions, saying whether it reached every instance (review 16 M2): for a caller
 * outside any transaction that must report the outcome truthfully — the identity re-link
 * command, after its chunk committed. Published at once (never deferred to a commit); never
 * throws: each stamp's outcome is answered, with why it was not published.
 */
export async function publishInvalidation(
  cognitoSub: string
): Promise<InvalidationOutcome> {
  for (const [key, entry] of cache) {
    if (entry.sub === cognitoSub) cache.delete(key);
  }
  const permissions = await publishStampNow(stampFor(cognitoSub));
  const tokens = await publishTokenRevocation(cognitoSub);
  return { permissions, tokens };
}

/**
 * Clear the entire cache, here and on every instance.
 * Useful for admin operations that affect many users.
 */
export async function clearPermissionsCache(): Promise<void> {
  cache.clear();
  await publishStamp(STAMP_ALL);
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
