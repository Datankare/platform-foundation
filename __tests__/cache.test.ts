/**
 * Cache Provider Tests.
 *
 * Tests both InMemoryCacheProvider and RedisCacheProvider.
 * Redis tests mock global fetch (Upstash REST API).
 */

import { InMemoryCacheProvider } from "../platform/cache/memory-cache";
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
describe("Cache factory", () => {
  afterEach(() => {
    resetCache();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("creates InMemory provider when no Redis env", () => {
    const cache = createCacheProvider();
    expect(cache.name).toBe("memory");
  });

  it("creates Redis provider when env is set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    const cache = createCacheProvider();
    expect(cache.name).toBe("redis");
  });

  it("falls back to memory if Redis env is incomplete", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    // No token
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
    const cache = createCacheProvider({ provider: "redis" });
    expect(cache.name).toBe("memory");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redis config incomplete")
    );
    consoleSpy.mockRestore();
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
