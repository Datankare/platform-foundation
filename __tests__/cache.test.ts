/**
 * Cache Provider Tests.
 *
 * Tests both InMemoryCacheProvider and RedisCacheProvider.
 * Redis tests mock global fetch (Upstash REST API).
 */

import { InMemoryCacheProvider, SWEEP_BATCH } from "../platform/cache/memory-cache";
import { RedisCacheProvider } from "../platform/cache/redis-cache";
import {
  createCacheProvider,
  getCache,
  resetCache,
  createCacheHealthProbe,
} from "../platform/cache/index";

// ============================================================
// InMemoryCacheProvider
// ============================================================
describe("InMemoryCacheProvider", () => {
  let cache: InMemoryCacheProvider;

  beforeEach(() => {
    cache = new InMemoryCacheProvider({ namespace: "test:", defaultTTLSeconds: 60 });
  });

  it("reports name as memory", () => {
    expect(cache.name).toBe("memory");
  });

  it("returns null for missing keys", async () => {
    expect(await cache.get("nonexistent")).toBeNull();
  });

  it("sets and gets a value", async () => {
    await cache.set("key1", { foo: "bar" });
    const result = await cache.get<{ foo: string }>("key1");
    expect(result).toEqual({ foo: "bar" });
  });

  it("sets and gets primitive values", async () => {
    await cache.set("str", "hello");
    await cache.set("num", 42);
    await cache.set("bool", true);
    expect(await cache.get("str")).toBe("hello");
    expect(await cache.get("num")).toBe(42);
    expect(await cache.get("bool")).toBe(true);
  });

  it("overwrites existing values", async () => {
    await cache.set("key1", "original");
    await cache.set("key1", "updated");
    expect(await cache.get("key1")).toBe("updated");
  });

  it("respects onlyIfAbsent", async () => {
    await cache.set("key1", "first");
    await cache.set("key1", "second", { onlyIfAbsent: true });
    expect(await cache.get("key1")).toBe("first");
  });

  it("onlyIfAbsent sets value if key does not exist", async () => {
    await cache.set("new-key", "value", { onlyIfAbsent: true });
    expect(await cache.get("new-key")).toBe("value");
  });

  it("deletes a key", async () => {
    await cache.set("key1", "value");
    const deleted = await cache.delete("key1");
    expect(deleted).toBe(true);
    expect(await cache.get("key1")).toBeNull();
  });

  it("delete returns false for missing key", async () => {
    const deleted = await cache.delete("nonexistent");
    expect(deleted).toBe(false);
  });

  it("checks key existence with has()", async () => {
    await cache.set("key1", "value");
    expect(await cache.has("key1")).toBe(true);
    expect(await cache.has("nonexistent")).toBe(false);
  });

  it("expires entries based on TTL", async () => {
    jest.useFakeTimers();
    await cache.set("key1", "value", { ttlSeconds: 5 });

    expect(await cache.get("key1")).toBe("value");

    // Advance past TTL
    jest.advanceTimersByTime(6000);

    expect(await cache.get("key1")).toBeNull();
    jest.useRealTimers();
  });

  it("has() returns false for expired entries", async () => {
    jest.useFakeTimers();
    await cache.set("key1", "value", { ttlSeconds: 2 });
    jest.advanceTimersByTime(3000);
    expect(await cache.has("key1")).toBe(false);
    jest.useRealTimers();
  });

  it("supports sliding expiry", async () => {
    jest.useFakeTimers();
    await cache.set("key1", "value", { ttlSeconds: 10 });

    // Access at t=8 with sliding expiry
    jest.advanceTimersByTime(8000);
    const value = await cache.get("key1", { slidingExpiry: true });
    expect(value).toBe("value");

    // Should still be alive at t=15 (refreshed at t=8, expires t=18)
    jest.advanceTimersByTime(7000);
    expect(await cache.get("key1")).toBe("value");

    // Expired at t=20
    jest.advanceTimersByTime(5000);
    expect(await cache.get("key1")).toBeNull();
    jest.useRealTimers();
  });

  it("clears only namespaced keys", async () => {
    await cache.set("key1", "v1");
    await cache.set("key2", "v2");

    // Manually add a key outside namespace
    const otherCache = new InMemoryCacheProvider({ namespace: "other:" });
    await otherCache.set("key3", "v3");

    await cache.clear();

    expect(await cache.get("key1")).toBeNull();
    expect(await cache.get("key2")).toBeNull();
    // Other namespace unaffected — different store
    expect(await otherCache.get("key3")).toBe("v3");
  });

  it("health check returns connected", async () => {
    const health = await cache.health();
    expect(health.connected).toBe(true);
    expect(health.provider).toBe("memory");
    expect(health.latencyMs).toBe(0);
  });

  it("exposes size for testing", async () => {
    await cache.set("a", 1);
    await cache.set("b", 2);
    expect(cache.size).toBe(2);
  });
});

// ============================================================
// RedisCacheProvider (mocked fetch)
// ============================================================
// Review 8 L3: expired entries were removed only when read again, so keys written once stayed
// for ever (a token hash per request, a revocation stamp per user).
describe("InMemoryCacheProvider — bounded and swept", () => {
  afterEach(() => jest.useRealTimers());

  it("sweeps expired entries as it is written to, without their being read", async () => {
    jest.useFakeTimers();
    const cache = new InMemoryCacheProvider();
    for (let i = 0; i < 200; i++) await cache.set(`old-${i}`, i, { ttlSeconds: 1 });
    jest.advanceTimersByTime(2000);
    // Each write examines SWEEP_BATCH entries: enough writes, and every expired one is gone.
    for (let i = 0; i < Math.ceil(200 / SWEEP_BATCH) + 2; i++)
      await cache.set(`new-${i}`, i, { ttlSeconds: 60 });
    expect(cache.size).toBe(Math.ceil(200 / SWEEP_BATCH) + 2);
  });

  it("never holds more than maxEntries: the expired go first, then the oldest written", async () => {
    jest.useFakeTimers();
    const cache = new InMemoryCacheProvider({ maxEntries: 100 });
    for (let i = 0; i < 50; i++) await cache.set(`short-${i}`, i, { ttlSeconds: 1 });
    for (let i = 0; i < 50; i++) await cache.set(`long-${i}`, i, { ttlSeconds: 60 });
    jest.advanceTimersByTime(2000);
    await cache.set("one-more", 1, { ttlSeconds: 60 });
    expect(cache.size).toBeLessThanOrEqual(100);
    expect(await cache.get("long-0")).toBe(0); // live entries kept while expired ones remain
    for (let i = 0; i < 500; i++) await cache.set(`flood-${i}`, i, { ttlSeconds: 60 });
    expect(cache.size).toBe(100);
    expect(await cache.get("long-0")).toBeNull(); // the oldest written went
    expect(await cache.get("flood-499")).toBe(499);
  });

  it("a key written again is the newest, and is not evicted first", async () => {
    const cache = new InMemoryCacheProvider({ maxEntries: 3 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);
    await cache.set("a", 4);
    await cache.set("d", 5);
    expect(await cache.get("a")).toBe(4);
    expect(await cache.get("b")).toBeNull();
  });

  it("an invalid maxEntries falls back to the default", async () => {
    const cache = new InMemoryCacheProvider({ maxEntries: -1 });
    for (let i = 0; i < 20; i++) await cache.set(`k${i}`, i);
    expect(cache.size).toBe(20);
  });
});

describe("RedisCacheProvider", () => {
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("throws if url or token is missing", () => {
    expect(() => new RedisCacheProvider({ url: "", token: "tok" })).toThrow(
      "requires url and token"
    );
    expect(() => new RedisCacheProvider({ url: "http://x", token: "" })).toThrow(
      "requires url and token"
    );
  });

  it("sets a value with TTL via REST API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "OK" }),
    });

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "test-token",
    });
    await cache.set("key1", { data: "hello" }, { ttlSeconds: 300 });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://redis.test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(["SET", "pf:key1", '{"data":"hello"}', "EX", "300"]),
      })
    );
  });

  it("gets a value from REST API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: '{"data":"hello"}' }),
    });

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "test-token",
    });
    const result = await cache.get<{ data: string }>("key1");

    expect(result).toEqual({ data: "hello" });
  });

  it("returns null for missing key", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: null }),
    });

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "test-token",
    });
    expect(await cache.get("missing")).toBeNull();
  });

  it("deletes a key", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 1 }),
    });

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "test-token",
    });
    const deleted = await cache.delete("key1");
    expect(deleted).toBe(true);
  });

  it("checks existence", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 1 }),
    });

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "test-token",
    });
    expect(await cache.has("key1")).toBe(true);
  });

  it("health check returns PONG", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "PONG" }),
    });

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "test-token",
    });
    const health = await cache.health();
    expect(health.connected).toBe(true);
    expect(health.provider).toBe("redis");
  });

  it("health check handles failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "test-token",
    });
    const health = await cache.health();
    expect(health.connected).toBe(false);
    expect(health.error).toBe("Network error");
  });

  it("handles HTTP errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "bad-token",
    });
    await expect(cache.get("key1")).rejects.toThrow("Redis HTTP 401");
  });

  it("sets with NX flag for onlyIfAbsent", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "OK" }),
    });

    const cache = new RedisCacheProvider({
      url: "https://redis.test",
      token: "test-token",
    });
    await cache.set("key1", "val", { onlyIfAbsent: true, ttlSeconds: 60 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toContain("NX");
  });
});

// ============================================================
// Factory / Singleton
// ============================================================
describe("Cache factory — the cache is chosen, never inferred (TASK-139)", () => {
  afterEach(() => {
    resetCache();
    delete process.env.CACHE_PROVIDER;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("creates the in-memory cache when nothing is chosen", () => {
    const cache = createCacheProvider();
    expect(cache.name).toBe("memory");
  });

  it("creates Redis when CACHE_PROVIDER=upstash with its credentials", () => {
    process.env.CACHE_PROVIDER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    expect(createCacheProvider().name).toBe("redis");
  });

  it("a Redis URL alone no longer selects Redis — the choice is CACHE_PROVIDER", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    expect(createCacheProvider().name).toBe("memory");
    process.env.CACHE_PROVIDER = "memory";
    expect(createCacheProvider().name).toBe("memory");
  });

  it("Redis chosen without its credentials throws — never a silent per-instance cache", () => {
    process.env.CACHE_PROVIDER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    expect(() => createCacheProvider()).toThrow(/UPSTASH_REDIS_REST_TOKEN/);
    expect(() => createCacheProvider({ provider: "redis" })).toThrow(/not set/);
    expect(() => getCache()).toThrow(/CACHE_PROVIDER=upstash/);
  });

  it("getCache returns singleton", () => {
    const a = getCache();
    const b = getCache();
    expect(a).toBe(b);
  });

  it("resetCache clears singleton", () => {
    const a = getCache();
    resetCache();
    const b = getCache();
    expect(a).not.toBe(b);
  });

  it("respects explicit config override", () => {
    const cache = createCacheProvider({ provider: "memory", namespace: "custom:" });
    expect(cache.name).toBe("memory");
  });
});

// ============================================================
// Cache Health Probe (observability integration)
// ============================================================
describe("createCacheHealthProbe", () => {
  it("returns healthy for connected InMemory cache", async () => {
    const cache = new InMemoryCacheProvider();
    const probe = createCacheHealthProbe(cache);

    expect(probe.name).toBe("cache:memory");
    const result = await probe.check();
    expect(result.status).toBe("healthy");
    expect(result.details?.provider).toBe("memory");
  });

  it("returns unhealthy when cache health fails", async () => {
    // Create a mock cache that fails health check
    const failingCache = {
      name: "broken",
      health: async () => ({
        connected: false,
        latencyMs: 0,
        provider: "broken",
        error: "Connection refused",
      }),
      get: async () => null,
      set: async () => {},
      delete: async () => false,
      has: async () => false,
      clear: async () => {},
    };

    const probe = createCacheHealthProbe(failingCache);
    const result = await probe.check();
    expect(result.status).toBe("unhealthy");
    expect(result.details?.error).toBe("Connection refused");
  });

  it("handles thrown errors gracefully", async () => {
    const throwingCache = {
      name: "throwing",
      health: async () => {
        throw new Error("Network down");
      },
      get: async () => null,
      set: async () => {},
      delete: async () => false,
      has: async () => false,
      clear: async () => {},
    };

    const probe = createCacheHealthProbe(throwingCache);
    const result = await probe.check();
    expect(result.status).toBe("unhealthy");
    expect(result.details?.error).toBe("Network down");
  });
});
