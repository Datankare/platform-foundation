/**
 * In-Memory Cache Provider.
 *
 * Zero-dependency fallback for development and testing.
 * NOT suitable for production multi-instance deployments
 * (each instance has its own cache — no shared state).
 *
 * Selected by CACHE_PROVIDER=memory, declared on purpose (TASK-139); never inferred. A
 * deployment may not select it (review 8 L3): token revocations and permission invalidations are
 * published through the cache, and a per-instance one reaches one instance only.
 *
 * Bounded (review 8 L3): expired entries were removed only when read again, so keys written once
 * — a token hash per request, a revocation stamp per user — stayed for ever. Now every write
 * sweeps a few entries (amortised: at most SWEEP_BATCH, resuming where the last sweep stopped),
 * and the store never holds more than maxEntries: at the limit the expired go first, then the
 * oldest written.
 *
 * @module platform/cache
 */

import type {
  CacheGetOptions,
  CacheHealthStatus,
  CacheProvider,
  CacheSetOptions,
} from "./types";

interface InternalEntry {
  value: unknown;
  createdAt: string;
  expiresAt: string | null;
  ttlSeconds: number | undefined;
}

/** Entries examined for expiry on each write. */
export const SWEEP_BATCH = 32;
/** The most entries one cache holds, by default. */
export const DEFAULT_MAX_ENTRIES = 10_000;

export class InMemoryCacheProvider implements CacheProvider {
  readonly name = "memory";
  private store = new Map<string, InternalEntry>();
  private readonly namespace: string;
  private readonly defaultTTLSeconds: number;
  private readonly maxEntries: number;
  /** Where the next sweep resumes. */
  private cursor: Iterator<[string, InternalEntry]> | undefined;

  constructor(options?: {
    namespace?: string;
    defaultTTLSeconds?: number;
    maxEntries?: number;
  }) {
    this.namespace = options?.namespace ?? "pf:";
    this.defaultTTLSeconds = options?.defaultTTLSeconds ?? 3600;
    const max = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxEntries = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_ENTRIES;
  }

  /** Examine up to `limit` entries from where the last sweep stopped; remove the expired. */
  private sweep(limit: number): void {
    for (let i = 0; i < limit && this.store.size > 0; i++) {
      this.cursor ??= this.store.entries();
      const next = this.cursor.next();
      if (next.done) {
        this.cursor = undefined;
        continue;
      }
      const [key, entry] = next.value;
      if (this.isExpired(entry)) this.store.delete(key);
    }
  }

  /** Room for one more entry: a few swept, then, at the limit, the expired, then the oldest. */
  private makeRoom(key: string): void {
    this.sweep(SWEEP_BATCH);
    if (this.store.has(key) || this.store.size < this.maxEntries) return;
    this.cursor = undefined;
    for (const [k, entry] of this.store) {
      if (this.store.size < this.maxEntries) return;
      if (this.isExpired(entry)) this.store.delete(k);
    }
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) return;
      this.store.delete(oldest.value);
    }
  }

  private prefixedKey(key: string): string {
    return `${this.namespace}${key}`;
  }

  private isExpired(entry: InternalEntry): boolean {
    if (!entry.expiresAt) return false;
    return new Date(entry.expiresAt).getTime() <= Date.now();
  }

  private computeExpiresAt(ttlSeconds?: number): string | null {
    const ttl = ttlSeconds ?? this.defaultTTLSeconds;
    if (ttl <= 0) return null;
    return new Date(Date.now() + ttl * 1000).toISOString();
  }

  async get<T = unknown>(key: string, options?: CacheGetOptions): Promise<T | null> {
    const prefixed = this.prefixedKey(key);
    const entry = this.store.get(prefixed);

    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.store.delete(prefixed);
      return null;
    }

    // Sliding expiry: reset TTL on access
    if (options?.slidingExpiry && entry.ttlSeconds) {
      entry.expiresAt = this.computeExpiresAt(entry.ttlSeconds);
    }

    return entry.value as T;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    options?: CacheSetOptions
  ): Promise<void> {
    const prefixed = this.prefixedKey(key);

    if (options?.onlyIfAbsent && this.store.has(prefixed)) {
      const existing = this.store.get(prefixed)!;
      if (!this.isExpired(existing)) return;
    }

    const ttlSeconds = options?.ttlSeconds ?? this.defaultTTLSeconds;

    this.makeRoom(prefixed);
    // Written again, it is the newest (Map order is insertion order: eviction takes the oldest).
    this.store.delete(prefixed);
    this.store.set(prefixed, {
      value,
      createdAt: new Date().toISOString(),
      expiresAt: this.computeExpiresAt(ttlSeconds),
      ttlSeconds: ttlSeconds > 0 ? ttlSeconds : undefined,
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(this.prefixedKey(key));
  }

  async has(key: string): Promise<boolean> {
    const prefixed = this.prefixedKey(key);
    const entry = this.store.get(prefixed);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(prefixed);
      return false;
    }
    return true;
  }

  async clear(): Promise<void> {
    const keysToDelete: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(this.namespace)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.store.delete(key);
    }
  }

  async health(): Promise<CacheHealthStatus> {
    return {
      connected: true,
      latencyMs: 0,
      provider: this.name,
    };
  }

  /** The instance is stopping: drop every entry (ADR-055 D5). */
  async close(): Promise<void> {
    this.store.clear();
  }

  /** Test helper: get raw store size (including expired entries) */
  get size(): number {
    return this.store.size;
  }
}
