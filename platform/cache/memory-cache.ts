/**
 * In-Memory Cache Provider.
 *
 * Zero-dependency fallback for development and testing.
 * NOT suitable for production multi-instance deployments
 * (each instance has its own cache — no shared state).
 *
 * Automatically selected when REDIS_URL is not configured.
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

export class InMemoryCacheProvider implements CacheProvider {
  readonly name = "memory";
  private store = new Map<string, InternalEntry>();
  private readonly namespace: string;
  private readonly defaultTTLSeconds: number;

  constructor(options?: { namespace?: string; defaultTTLSeconds?: number }) {
    this.namespace = options?.namespace ?? "pf:";
    this.defaultTTLSeconds = options?.defaultTTLSeconds ?? 3600;
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

  /** Test helper: get raw store size (including expired entries) */
  get size(): number {
    return this.store.size;
  }
}
