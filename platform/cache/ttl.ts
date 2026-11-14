/**
 * platform/cache/ttl.ts — every cache entry expires (TASK-215, the S4 retention sweep by store)
 *
 * The cache took "no expiry" for an entry with no TTL, a TTL of 0 or less, or a CACHE_DEFAULT_TTL of
 * 0: an entry kept for as long as the store — a shared Valkey keeps it across every deployment.
 * Every call today passes a TTL, but nothing held the next one to it, and an AI answer (which can
 * repeat what a person wrote) is an entry like any other. Now no entry outlives
 * CACHE_MAX_TTL_SECONDS: a TTL that is missing, not a number, or not positive is the store's
 * default, and the default itself is bounded the same way.
 *
 * @module platform/cache
 */

/** The default when none is configured: an hour. */
export const CACHE_DEFAULT_TTL_SECONDS = 3600;
/** The longest an entry is kept, whatever is asked: seven days. */
export const CACHE_MAX_TTL_SECONDS = 7 * 24 * 3600;

/** A store's default TTL: the configured one if it is a positive number, bounded; else an hour. */
export function boundedDefaultTtl(configured: number | undefined): number {
  return configured !== undefined && Number.isFinite(configured) && configured > 0
    ? Math.min(Math.ceil(configured), CACHE_MAX_TTL_SECONDS)
    : CACHE_DEFAULT_TTL_SECONDS;
}

/** An entry's TTL: the one asked for if it is a positive number, bounded; else the default. */
export function boundedTtl(asked: number | undefined, defaultTtl: number): number {
  return asked !== undefined && Number.isFinite(asked) && asked > 0
    ? Math.min(Math.ceil(asked), CACHE_MAX_TTL_SECONDS)
    : boundedDefaultTtl(defaultTtl);
}
