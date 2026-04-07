/**
 * AI Cache Tests — GenAI-native cache layer.
 *
 * Tests buildAICacheKey(), AICache hit/miss, metrics callbacks,
 * and GDPR purge integration.
 */

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { AICache, buildAICacheKey, resetAICache } from "../platform/cache/ai-cache";
import { InMemoryCacheProvider } from "../platform/cache/memory-cache";
import type { AICacheMetricsCallback } from "../platform/cache/ai-cache";
import type { AIRequest, AIResponse } from "@/platform/ai";

const makeRequest = (overrides?: Partial<AIRequest>): AIRequest => ({
  maxTokens: 1024,
  tier: "fast",
  system: "You are a test assistant.",
  messages: [{ role: "user", content: "Hello" }],
  ...overrides,
});

const makeResponse = (overrides?: Partial<AIResponse>): AIResponse => ({
  content: [{ type: "text", text: "Hello back" }],
  model: "claude-haiku",
  usage: { inputTokens: 100, outputTokens: 50 },
  stopReason: "end_turn",
  ...overrides,
});

describe("buildAICacheKey", () => {
  it("generates deterministic keys", () => {
    const req = makeRequest();
    const key1 = buildAICacheKey(req);
    const key2 = buildAICacheKey(req);
    expect(key1).toBe(key2);
  });

  it("generates different keys for different prompts", () => {
    const req1 = makeRequest({ system: "System A" });
    const req2 = makeRequest({ system: "System B" });
    expect(buildAICacheKey(req1)).not.toBe(buildAICacheKey(req2));
  });

  it("generates different keys for different messages", () => {
    const req1 = makeRequest({
      messages: [{ role: "user", content: "Hello" }],
    });
    const req2 = makeRequest({
      messages: [{ role: "user", content: "Goodbye" }],
    });
    expect(buildAICacheKey(req1)).not.toBe(buildAICacheKey(req2));
  });

  it("generates different keys for different tiers", () => {
    const req1 = makeRequest({ tier: "fast" });
    const req2 = makeRequest({ tier: "standard" });
    expect(buildAICacheKey(req1)).not.toBe(buildAICacheKey(req2));
  });

  it("includes tools in key when present", () => {
    const req1 = makeRequest();
    const req2 = makeRequest({
      tools: [
        {
          name: "search",
          description: "Search tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    expect(buildAICacheKey(req1)).not.toBe(buildAICacheKey(req2));
  });

  it("key starts with ai: prefix", () => {
    expect(buildAICacheKey(makeRequest())).toMatch(/^ai:/);
  });
});

describe("AICache", () => {
  let cache: InMemoryCacheProvider;
  let aiCache: AICache;

  beforeEach(() => {
    cache = new InMemoryCacheProvider({ namespace: "test:", defaultTTLSeconds: 60 });
    aiCache = new AICache({ cache, defaultTTLSeconds: 300 });
  });

  afterEach(() => {
    resetAICache();
  });

  it("returns null on cache miss", async () => {
    const result = await aiCache.get(makeRequest(), "test");
    expect(result).toBeNull();
  });

  it("returns cached response on cache hit", async () => {
    const req = makeRequest();
    const resp = makeResponse();

    await aiCache.set(req, resp, "test");
    const cached = await aiCache.get(req, "test");

    expect(cached).toEqual(resp);
  });

  it("tracks hit/miss stats", async () => {
    const req = makeRequest();

    await aiCache.get(req, "test"); // miss
    await aiCache.set(req, makeResponse(), "test");
    await aiCache.get(req, "test"); // hit
    await aiCache.get(req, "test"); // hit

    expect(aiCache.stats.hits).toBe(2);
    expect(aiCache.stats.misses).toBe(1);
    expect(aiCache.stats.hitRate).toBeCloseTo(2 / 3);
  });

  it("calls metrics callback on hit", async () => {
    const metrics: AICacheMetricsCallback = {
      onCacheHit: jest.fn(),
      onCacheMiss: jest.fn(),
    };
    aiCache = new AICache({ cache, metrics });

    const req = makeRequest();
    await aiCache.set(req, makeResponse(), "classify");
    await aiCache.get(req, "classify");

    expect(metrics.onCacheHit).toHaveBeenCalledWith(
      expect.any(String),
      "classify",
      expect.any(Number)
    );
  });

  it("calls metrics callback on miss", async () => {
    const metrics: AICacheMetricsCallback = {
      onCacheHit: jest.fn(),
      onCacheMiss: jest.fn(),
    };
    aiCache = new AICache({ cache, metrics });

    await aiCache.get(makeRequest(), "classify");

    expect(metrics.onCacheMiss).toHaveBeenCalledWith(expect.any(String), "classify");
  });

  it("reports saved cost on cache hit", async () => {
    const metrics: AICacheMetricsCallback = {
      onCacheHit: jest.fn(),
      onCacheMiss: jest.fn(),
    };
    aiCache = new AICache({ cache, metrics });

    const resp = makeResponse({ usage: { inputTokens: 1000, outputTokens: 500 } });
    const req = makeRequest();
    await aiCache.set(req, resp, "test");
    await aiCache.get(req, "test");

    // Cost should be > 0 (actual tokens were saved)
    const savedCost = (metrics.onCacheHit as jest.Mock).mock.calls[0][2];
    expect(savedCost).toBeGreaterThan(0);
  });

  it("respects TTL by use case", async () => {
    jest.useFakeTimers();
    aiCache = new AICache({
      cache,
      defaultTTLSeconds: 600,
      ttlByUseCase: { "short-lived": 5 },
    });

    const req = makeRequest();
    await aiCache.set(req, makeResponse(), "short-lived");

    jest.advanceTimersByTime(6000);
    const result = await aiCache.get(req, "short-lived");
    expect(result).toBeNull();
    jest.useRealTimers();
  });

  it("invalidates specific cached response", async () => {
    const req = makeRequest();
    await aiCache.set(req, makeResponse(), "test");

    await aiCache.invalidate(req);
    expect(await aiCache.get(req, "test")).toBeNull();
  });

  it("clears all cached AI responses", async () => {
    await aiCache.set(makeRequest({ system: "A" }), makeResponse(), "test");
    await aiCache.set(makeRequest({ system: "B" }), makeResponse(), "test");

    await aiCache.clearAll();

    expect(await aiCache.get(makeRequest({ system: "A" }), "test")).toBeNull();
    expect(await aiCache.get(makeRequest({ system: "B" }), "test")).toBeNull();
  });

  it("does nothing when disabled", async () => {
    aiCache = new AICache({ cache, enabled: false });
    const req = makeRequest();

    await aiCache.set(req, makeResponse(), "test");
    const result = await aiCache.get(req, "test");

    expect(result).toBeNull();
  });

  it("gracefully handles cache provider errors on get", async () => {
    const brokenCache = {
      ...cache,
      get: async () => {
        throw new Error("Redis down");
      },
    } as unknown as InMemoryCacheProvider;
    aiCache = new AICache({ cache: brokenCache });

    // Should return null, not throw
    const result = await aiCache.get(makeRequest(), "test");
    expect(result).toBeNull();
    expect(aiCache.stats.misses).toBe(1);
  });

  it("purgeUserData clears AI cache", async () => {
    await aiCache.set(makeRequest(), makeResponse(), "test");
    await aiCache.purgeUserData("user-123");

    expect(await aiCache.get(makeRequest(), "test")).toBeNull();
  });
});

describe("Token-aware rate limit types", () => {
  it("TOKEN_BUDGET_RULES are importable and valid", async () => {
    const { TOKEN_BUDGET_RULES } = await import("../platform/rate-limit/token-aware");
    expect(TOKEN_BUDGET_RULES.FREE_TIER_DAILY.maxTokensPerWindow).toBe(50_000);
    expect(TOKEN_BUDGET_RULES.PRO_TIER_DAILY.maxTokensPerWindow).toBe(500_000);
    expect(TOKEN_BUDGET_RULES.ENTERPRISE_TIER_DAILY.maxTokensPerWindow).toBe(5_000_000);
  });

  it("token budget rules extend base rate limit rules", async () => {
    const { TOKEN_BUDGET_RULES } = await import("../platform/rate-limit/token-aware");
    // Must have base RateLimitRule fields
    const rule = TOKEN_BUDGET_RULES.FREE_TIER_DAILY;
    expect(rule.id).toBeTruthy();
    expect(rule.maxRequests).toBeGreaterThan(0);
    expect(rule.windowSeconds).toBeGreaterThan(0);
    // Plus token-aware fields
    expect(rule.maxTokensPerWindow).toBeGreaterThan(0);
    expect(rule.maxCostPerWindow).toBeGreaterThan(0);
  });
});

describe("AI Purge Handlers", () => {
  it("AIMetricsPurgeHandler calls deleteFn", async () => {
    const { AIMetricsPurgeHandler } = await import("../platform/gdpr/ai-purge-handler");
    const deleteFn = jest.fn().mockResolvedValue(15);
    const handler = new AIMetricsPurgeHandler(deleteFn);

    expect(handler.name).toBe("ai:metrics");
    expect(handler.priority).toBe(50);

    const count = await handler.execute("user-123", false);
    expect(count).toBe(15);
    expect(deleteFn).toHaveBeenCalledWith("user-123");
  });

  it("AIMetricsPurgeHandler returns 0 on dry run", async () => {
    const { AIMetricsPurgeHandler } = await import("../platform/gdpr/ai-purge-handler");
    const deleteFn = jest.fn();
    const handler = new AIMetricsPurgeHandler(deleteFn);

    const count = await handler.execute("user-123", true);
    expect(count).toBe(0);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("AICachePurgeHandler calls purgeFn", async () => {
    const { AICachePurgeHandler } = await import("../platform/gdpr/ai-purge-handler");
    const purgeFn = jest.fn().mockResolvedValue(0);
    const handler = new AICachePurgeHandler(purgeFn);

    expect(handler.name).toBe("ai:cached-responses");
    expect(handler.priority).toBe(85);

    await handler.execute("user-123", false);
    expect(purgeFn).toHaveBeenCalledWith("user-123");
  });
});
