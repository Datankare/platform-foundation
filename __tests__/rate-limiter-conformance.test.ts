/**
 * RateLimiter conformance (ADR-027, ADR-052): the memory store; the Upstash store against an
 * emulation of the Redis REST API. The Postgres store runs the same kit against the real
 * database in __tests__/db/rate-limiter.db.test.ts. The memory and Redis stores also keep
 * tenants apart (ADR-053 D6).
 */
import { runRateLimiterContract } from "./contract/rate-limiter-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import { randomUUID } from "node:crypto";
import {
  InMemoryRateLimiter,
  RedisRateLimiter,
  type RateLimiter,
  type RateLimitRule,
} from "@/platform/rate-limit";
import { runWithTenant } from "@/platform/tenancy/context";
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

const ISO_RULE: RateLimitRule = { id: "iso", maxRequests: 5, windowSeconds: 60 };

/** One tenant for the isolation kit: a fresh random id per call. */
const memoryTenant = async () => {
  const ctx = Object.freeze({ tenantId: randomUUID(), mode: "shared" as const });
  return { run: <T>(fn: () => T): T => runWithTenant(ctx, fn) };
};

/** A bucket "exists" for a tenant once it has counted a request. */
const isolationFixtures = (makeStore: () => RateLimiter) => ({
  makeStore,
  createTenant: memoryTenant,
  write: async (l: RateLimiter, key: string) => {
    await l.check(key, ISO_RULE);
  },
  read: async (l: RateLimiter, key: string) => {
    const r = await l.peek(key, ISO_RULE);
    // The record is its count; resetAt moves with the clock, so it is not compared.
    return r.remaining < ISO_RULE.maxRequests
      ? { limit: r.limit, remaining: r.remaining }
      : null;
  },
  update: async (l: RateLimiter, key: string) => {
    await l.check(key, ISO_RULE);
  },
  remove: async (l: RateLimiter, key: string) => l.reset(key, ISO_RULE),
  failsClosedWithoutTenant: false,
});

describe("InMemoryRateLimiter — tenants", () => {
  runTenantIsolationContract({
    name: "rate-limit (memory)",
    ...isolationFixtures(() => new InMemoryRateLimiter({ cleanupIntervalMs: 0 })),
  });
});

describe("RedisRateLimiter — tenants (REST emulation)", () => {
  runTenantIsolationContract({
    name: "rate-limit (redis)",
    ...isolationFixtures(() => {
      emulateUpstash();
      return new RedisRateLimiter({ url: "https://redis.example", token: "t" });
    }),
  });

  it("puts the current tenant in every key", async () => {
    emulateUpstash();
    const l = new RedisRateLimiter({ url: "https://redis.example", token: "t" });
    const tenantId = randomUUID();
    await runWithTenant({ tenantId, mode: "shared" }, () => l.check("ip:a", ISO_RULE));
    const commands = JSON.parse(
      String(mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1]?.body)
    ) as string[][];
    expect(commands[1][1]).toBe(`rl:${tenantId}:iso:ip:a`);
  });
});
