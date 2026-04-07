/**
 * Rate Limiter Tests.
 *
 * Tests InMemoryRateLimiter, RedisRateLimiter (mocked fetch), and factory.
 */

import { InMemoryRateLimiter } from "../platform/rate-limit/memory-limiter";
import { RedisRateLimiter } from "../platform/rate-limit/redis-limiter";
import {
  createRateLimiter,
  getRateLimiter,
  resetRateLimiter,
  DEFAULT_RULES,
} from "../platform/rate-limit/index";
import type { RateLimitRule } from "../platform/rate-limit/types";

const TEST_RULE: RateLimitRule = {
  id: "test:basic",
  maxRequests: 3,
  windowSeconds: 60,
};

// ============================================================
// InMemoryRateLimiter
// ============================================================
describe("InMemoryRateLimiter", () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    limiter = new InMemoryRateLimiter({ namespace: "test:", cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    limiter.destroy();
  });

  it("reports name as memory", () => {
    expect(limiter.name).toBe("memory");
  });

  it("allows requests under the limit", async () => {
    const r1 = await limiter.check("user1", TEST_RULE);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await limiter.check("user1", TEST_RULE);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
  });

  it("blocks requests over the limit", async () => {
    await limiter.check("user1", TEST_RULE);
    await limiter.check("user1", TEST_RULE);
    await limiter.check("user1", TEST_RULE);

    const r4 = await limiter.check("user1", TEST_RULE);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks different identifiers independently", async () => {
    await limiter.check("user1", TEST_RULE);
    await limiter.check("user1", TEST_RULE);
    await limiter.check("user1", TEST_RULE);

    // user2 should still have full quota
    const r = await limiter.check("user2", TEST_RULE);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it("tracks different rules independently", async () => {
    const rule2: RateLimitRule = { id: "test:other", maxRequests: 1, windowSeconds: 60 };

    await limiter.check("user1", TEST_RULE);
    const r = await limiter.check("user1", rule2);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0); // 1 max - 1 used
  });

  it("resets window after TTL expires", async () => {
    jest.useFakeTimers();
    const shortRule: RateLimitRule = {
      id: "test:short",
      maxRequests: 1,
      windowSeconds: 5,
    };

    await limiter.check("user1", shortRule);
    const blocked = await limiter.check("user1", shortRule);
    expect(blocked.allowed).toBe(false);

    // Advance past window
    jest.advanceTimersByTime(6000);

    const allowed = await limiter.check("user1", shortRule);
    expect(allowed.allowed).toBe(true);
    jest.useRealTimers();
  });

  it("peek does not consume a request", async () => {
    await limiter.check("user1", TEST_RULE); // Consume 1

    const peek = await limiter.peek("user1", TEST_RULE);
    expect(peek.remaining).toBe(2);

    // Peek again — should still be 2
    const peek2 = await limiter.peek("user1", TEST_RULE);
    expect(peek2.remaining).toBe(2);
  });

  it("reset clears an identifier", async () => {
    await limiter.check("user1", TEST_RULE);
    await limiter.check("user1", TEST_RULE);
    await limiter.check("user1", TEST_RULE);

    await limiter.reset("user1", TEST_RULE);

    const r = await limiter.check("user1", TEST_RULE);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it("returns correct limit and resetAt", async () => {
    const r = await limiter.check("user1", TEST_RULE);
    expect(r.limit).toBe(3);
    expect(r.resetAt).toBeGreaterThan(0);
  });

  it("exposes size for testing", async () => {
    await limiter.check("user1", TEST_RULE);
    await limiter.check("user2", TEST_RULE);
    expect(limiter.size).toBe(2);
  });
});

// ============================================================
// RedisRateLimiter (mocked fetch)
// ============================================================
describe("RedisRateLimiter", () => {
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("throws if url or token missing", () => {
    expect(() => new RedisRateLimiter({ url: "", token: "t" })).toThrow();
    expect(() => new RedisRateLimiter({ url: "http://x", token: "" })).toThrow();
  });

  it("allows request when under limit", async () => {
    // Pipeline: ZREMRANGEBYSCORE, ZADD, ZCARD, EXPIRE
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { result: 0 },
        { result: 1 },
        { result: 1 }, // ZCARD = 1 (under limit of 3)
        { result: 1 },
      ],
    });

    const limiter = new RedisRateLimiter({
      url: "https://redis.test",
      token: "tok",
    });
    const result = await limiter.check("user1", TEST_RULE);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("blocks request when over limit", async () => {
    // Pipeline returns ZCARD = 4 (over limit of 3)
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ result: 0 }, { result: 1 }, { result: 4 }, { result: 1 }],
      })
      // ZREM call to remove the just-added entry
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 1 }),
      });

    const limiter = new RedisRateLimiter({
      url: "https://redis.test",
      token: "tok",
    });
    const result = await limiter.check("user1", TEST_RULE);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("peek reads without consuming", async () => {
    // Pipeline: ZREMRANGEBYSCORE, ZCARD
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { result: 0 },
        { result: 2 }, // 2 existing entries
      ],
    });

    const limiter = new RedisRateLimiter({
      url: "https://redis.test",
      token: "tok",
    });
    const result = await limiter.peek("user1", TEST_RULE);
    expect(result.remaining).toBe(1);
    expect(result.allowed).toBe(true);

    // Only one fetch call (pipeline), no ZADD
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("reset deletes the key", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 1 }),
    });

    const limiter = new RedisRateLimiter({
      url: "https://redis.test",
      token: "tok",
    });
    await limiter.reset("user1", TEST_RULE);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body[0]).toBe("DEL");
  });

  it("handles HTTP errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const limiter = new RedisRateLimiter({
      url: "https://redis.test",
      token: "tok",
    });
    await expect(limiter.check("user1", TEST_RULE)).rejects.toThrow(
      "Redis pipeline HTTP 500"
    );
  });
});

// ============================================================
// DEFAULT_RULES
// ============================================================
describe("DEFAULT_RULES", () => {
  it("defines API_GLOBAL", () => {
    expect(DEFAULT_RULES.API_GLOBAL.maxRequests).toBe(100);
    expect(DEFAULT_RULES.API_GLOBAL.windowSeconds).toBe(60);
  });

  it("defines AI_PER_USER", () => {
    expect(DEFAULT_RULES.AI_PER_USER.maxRequests).toBe(20);
  });

  it("defines AUTH_LOGIN", () => {
    expect(DEFAULT_RULES.AUTH_LOGIN.maxRequests).toBe(10);
    expect(DEFAULT_RULES.AUTH_LOGIN.windowSeconds).toBe(900);
  });

  it("defines ADMIN_OPS", () => {
    expect(DEFAULT_RULES.ADMIN_OPS.maxRequests).toBe(30);
  });
});

// ============================================================
// Factory / Singleton
// ============================================================
describe("Rate limiter factory", () => {
  afterEach(() => {
    resetRateLimiter();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("creates InMemory when no Redis env", () => {
    const limiter = createRateLimiter();
    expect(limiter.name).toBe("memory");
  });

  it("creates Redis when env is set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    const limiter = createRateLimiter();
    expect(limiter.name).toBe("redis");
  });

  it("falls back to memory if Redis env incomplete", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
    const limiter = createRateLimiter({ provider: "redis" });
    expect(limiter.name).toBe("memory");
    consoleSpy.mockRestore();
  });

  it("getRateLimiter returns singleton", () => {
    const a = getRateLimiter();
    const b = getRateLimiter();
    expect(a).toBe(b);
  });

  it("resetRateLimiter clears singleton", () => {
    const a = getRateLimiter();
    resetRateLimiter();
    const b = getRateLimiter();
    expect(a).not.toBe(b);
  });
});
