/**
 * RateLimiter conformance (ADR-027, ADR-052): the memory store; the Upstash store against an
 * emulation of the Redis REST API; the Supabase store against an emulation of migration 039's
 * rate_limit_hit / rate_limit_reset. The SQL itself is exercised on real Postgres by the
 * migration replay (scripts/migration-replay.sh), including concurrency.
 */
import { runRateLimiterContract } from "./contract/rate-limiter-contract";
import {
  InMemoryRateLimiter,
  RedisRateLimiter,
  SupabaseRateLimiter,
} from "@/platform/rate-limit";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

jest.mock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));
const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

/** Redis sorted sets, as the limiter uses them over Upstash's REST API. */
function emulateUpstash(): void {
  const sets = new Map<string, Map<string, number>>();
  const zset = (k: string): Map<string, number> => {
    if (!sets.has(k)) sets.set(k, new Map());
    return sets.get(k) as Map<string, number>;
  };
  const run = (cmd: string[]): unknown => {
    const [op, key, ...args] = cmd;
    switch (op) {
      case "ZREMRANGEBYSCORE": {
        const max = Number(args[1]);
        for (const [m, s] of zset(key)) if (s <= max) zset(key).delete(m);
        return 0;
      }
      case "ZADD":
        zset(key).set(args[1], Number(args[0]));
        return 1;
      case "ZCARD":
        return zset(key).size;
      case "ZREM":
        zset(key).delete(args[0]);
        return 1;
      case "EXPIRE":
        return 1;
      case "DEL":
        sets.delete(key);
        return 1;
      default:
        throw new Error(`not emulated: ${op}`);
    }
  };
  mockFetch.mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith("/pipeline")) {
      return json(
        200,
        (body as string[][]).map((c) => ({ result: run(c) }))
      );
    }
    return json(200, { result: run(body as string[]) });
  });
}

/** Migration 039's functions: exact sliding window per bucket, database clock. */
function emulateSupabase(): void {
  const buckets = new Map<string, number[]>();
  mockFetch.mockImplementation(async (input, init) => {
    const url = String(input);
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith("/rpc/rate_limit_hit")) {
      const now = Date.now();
      const windowMs = Number(b.p_window_seconds) * 1000;
      const events = (buckets.get(String(b.p_bucket)) ?? []).filter(
        (t) => t > now - windowMs
      );
      const limit = Number(b.p_limit);
      if (events.length >= limit) {
        buckets.set(String(b.p_bucket), events);
        return json(200, [
          {
            allowed: false,
            used: events.length,
            retry_after_seconds: Math.max(
              1,
              Math.ceil((events[0] + windowMs - now) / 1000)
            ),
            reset_at: Math.ceil((events[0] + windowMs) / 1000),
          },
        ]);
      }
      if (b.p_consume) events.push(now);
      buckets.set(String(b.p_bucket), events);
      return json(200, [
        {
          allowed: true,
          used: events.length,
          retry_after_seconds: 0,
          reset_at: Math.ceil(((events[0] ?? now) + windowMs) / 1000),
        },
      ]);
    }
    if (url.endsWith("/rpc/rate_limit_reset")) {
      buckets.delete(String(b.p_bucket));
      return new Response(null, { status: 204 });
    }
    return json(404, { message: "not emulated" });
  });
}

describe("InMemoryRateLimiter — conformance", () => {
  runRateLimiterContract({
    makeLimiter: () => new InMemoryRateLimiter({ cleanupIntervalMs: 0 }),
  });
});

describe("RedisRateLimiter (Upstash) — conformance (REST emulation)", () => {
  runRateLimiterContract({
    makeLimiter: () => {
      emulateUpstash();
      return new RedisRateLimiter({ url: "https://redis.example", token: "t" });
    },
  });
});

describe("SupabaseRateLimiter — conformance (PostgREST emulation of migration 039)", () => {
  runRateLimiterContract({
    makeLimiter: () => {
      emulateSupabase();
      return new SupabaseRateLimiter({ url: "https://x.supabase.co", serviceKey: "key" });
    },
  });
});

describe("SupabaseRateLimiter — calls", () => {
  it("sends the bucket, limit, window and consume flag, never retried", async () => {
    emulateSupabase();
    const l = new SupabaseRateLimiter({
      url: "https://x.supabase.co/",
      serviceKey: "key",
    });
    await l.check("ip:1.2.3.4", { id: "r", maxRequests: 5, windowSeconds: 30 });
    const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(url).toBe("https://x.supabase.co/rest/v1/rpc/rate_limit_hit");
    expect(init).toMatchObject({ method: "POST", maxRetries: 0 });
    expect(JSON.parse(String(init?.body))).toEqual({
      p_bucket: "rl:r:ip:1.2.3.4",
      p_limit: 5,
      p_window_seconds: 30,
      p_consume: true,
    });
  });

  it("throws when the database refuses", async () => {
    mockFetch.mockResolvedValue(new Response("boom", { status: 500 }));
    const l = new SupabaseRateLimiter({
      url: "https://x.supabase.co",
      serviceKey: "key",
    });
    await expect(
      l.check("ip:a", { id: "r", maxRequests: 1, windowSeconds: 1 })
    ).rejects.toThrow(/rate_limit_hit failed \(500\)/);
  });

  it("throws on an empty answer", async () => {
    mockFetch.mockResolvedValue(json(200, []));
    const l = new SupabaseRateLimiter({
      url: "https://x.supabase.co",
      serviceKey: "key",
    });
    await expect(
      l.check("ip:a", { id: "r", maxRequests: 1, windowSeconds: 1 })
    ).rejects.toThrow(/returned no row/);
  });

  it("requires a URL and key", () => {
    expect(() => new SupabaseRateLimiter({ url: "", serviceKey: "k" })).toThrow(
      /requires/
    );
  });
});
