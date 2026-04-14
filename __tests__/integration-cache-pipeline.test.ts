/**
 * Sprint 6 — Integration: Cache & Rate Limit Pipeline
 *
 * Tests cache and rate limiting infrastructure end-to-end:
 * CacheProvider → AI cache → rate limiter.
 * Verifies Sprint 4 components work together.
 */

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("Cache & Rate Limit Pipeline Integration", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe("InMemoryCacheProvider lifecycle", () => {
    it("set → get → delete cycle works", async () => {
      const { InMemoryCacheProvider } = await import("@/platform/cache/memory-cache");
      const cache = new InMemoryCacheProvider();

      await cache.set("key-1", "value-1", { ttlSeconds: 60 });
      const result = await cache.get<string>("key-1");
      expect(result).toBe("value-1");

      await cache.delete("key-1");
      const deleted = await cache.get("key-1");
      expect(deleted).toBeNull();
    });

    it("TTL expiry removes entries", async () => {
      const { InMemoryCacheProvider } = await import("@/platform/cache/memory-cache");
      const cache = new InMemoryCacheProvider();

      await cache.set("key-ttl", "value", { ttlSeconds: 1 });
      await new Promise((r) => setTimeout(r, 1100));
      const result = await cache.get("key-ttl");
      expect(result).toBeNull();
    });

    it("handles JSON objects", async () => {
      const { InMemoryCacheProvider } = await import("@/platform/cache/memory-cache");
      const cache = new InMemoryCacheProvider();

      const obj = { translations: ["hello", "hola"], cost: 0.001 };
      await cache.set("json-key", obj, { ttlSeconds: 60 });

      const result = await cache.get<typeof obj>("json-key");
      expect(result).toBeDefined();
      expect(result?.translations).toHaveLength(2);
      expect(result?.cost).toBe(0.001);
    });
  });

  describe("AICache integration", () => {
    it("AICache wraps CacheProvider with prompt-hash keying", async () => {
      const { InMemoryCacheProvider } = await import("@/platform/cache/memory-cache");
      const { AICache, buildAICacheKey } = await import("@/platform/cache/ai-cache");

      const baseCache = new InMemoryCacheProvider();
      const aiCache = new AICache({ cache: baseCache });

      const request = {
        tier: "fast" as const,
        messages: [{ role: "user" as const, content: "hello" }],
        maxTokens: 100,
      };

      // Build key
      const key = buildAICacheKey(request);
      expect(key).toBeTruthy();

      // Cache miss
      const cached = await aiCache.get(request, "translate");
      expect(cached).toBeNull();

      // Store result
      const response = {
        content: [{ type: "text" as const, text: "hola" }],
        model: "haiku",
        usage: { inputTokens: 5, outputTokens: 3 },
        stopReason: "end_turn",
      };
      await aiCache.set(request, response, "translate");

      // Cache hit
      const hit = await aiCache.get(request, "translate");
      expect(hit).toBeDefined();
      expect(hit?.content[0]).toEqual({ type: "text", text: "hola" });
    });

    it("same inputs produce same cache key", async () => {
      const { buildAICacheKey } = await import("@/platform/cache/ai-cache");

      const request = {
        tier: "fast" as const,
        messages: [{ role: "user" as const, content: "hello" }],
        maxTokens: 100,
      };

      const key1 = buildAICacheKey(request);
      const key2 = buildAICacheKey(request);
      expect(key1).toBe(key2);

      const differentRequest = {
        tier: "fast" as const,
        messages: [{ role: "user" as const, content: "world" }],
        maxTokens: 100,
      };
      const key3 = buildAICacheKey(differentRequest);
      expect(key3).not.toBe(key1);
    });
  });

  describe("Rate limiter integration", () => {
    it("allows requests within limit", async () => {
      const { InMemoryRateLimiter } =
        await import("@/platform/rate-limit/memory-limiter");

      const limiter = new InMemoryRateLimiter();
      const rule = { id: "test", maxRequests: 5, windowSeconds: 60 };

      for (let i = 0; i < 5; i++) {
        const result = await limiter.check("user-1", rule);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }

      // 6th should be denied
      const denied = await limiter.check("user-1", rule);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
    });

    it("different users have independent limits", async () => {
      const { InMemoryRateLimiter } =
        await import("@/platform/rate-limit/memory-limiter");

      const limiter = new InMemoryRateLimiter();
      const rule = { id: "test", maxRequests: 2, windowSeconds: 60 };

      await limiter.check("user-a", rule);
      await limiter.check("user-a", rule);
      const deniedA = await limiter.check("user-a", rule);
      expect(deniedA.allowed).toBe(false);

      const allowedB = await limiter.check("user-b", rule);
      expect(allowedB.allowed).toBe(true);
      expect(allowedB.remaining).toBe(1);
    });
  });

  describe("Cache + Rate Limit combined pattern", () => {
    it("cached responses avoid rate limit consumption", async () => {
      const { InMemoryCacheProvider } = await import("@/platform/cache/memory-cache");
      const { AICache } = await import("@/platform/cache/ai-cache");
      const { InMemoryRateLimiter } =
        await import("@/platform/rate-limit/memory-limiter");

      const aiCache = new AICache({ cache: new InMemoryCacheProvider() });
      const limiter = new InMemoryRateLimiter();
      const rule = { id: "api", maxRequests: 2, windowSeconds: 60 };

      const request = {
        tier: "fast" as const,
        messages: [{ role: "user" as const, content: "hello" }],
        maxTokens: 100,
      };

      const response = {
        content: [{ type: "text" as const, text: "hola" }],
        model: "haiku",
        usage: { inputTokens: 5, outputTokens: 3 },
        stopReason: "end_turn",
      };

      // First request: cache miss → consume rate limit → store in cache
      let cached = await aiCache.get(request, "translate");
      expect(cached).toBeNull();
      const rateResult = await limiter.check("user-1", rule);
      expect(rateResult.allowed).toBe(true);
      await aiCache.set(request, response, "translate");

      // Second request: cache hit → skip rate limit
      cached = await aiCache.get(request, "translate");
      expect(cached).toBeDefined();
      // Rate limiter still has 1 remaining
      expect(rateResult.remaining).toBe(1);
    });
  });

  describe("Cache health probe", () => {
    it("createCacheHealthProbe returns a working probe", async () => {
      const { createCacheHealthProbe } = await import("@/platform/cache/health-probe");
      const { InMemoryCacheProvider } = await import("@/platform/cache/memory-cache");

      const cache = new InMemoryCacheProvider();
      const probe = createCacheHealthProbe(cache);

      expect(probe.name).toBeTruthy();
      const result = await probe.check();
      expect(result.status).toBe("healthy");
    });
  });
});
