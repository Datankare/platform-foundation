/**
 * @jest-environment node
 */
/**
 * PostgresRateLimiter against the replayed database (ADR-052, ADR-053 D4): the conformance kit
 * inside one tenant (each test a fresh tenant, so empty counters), the limiter isolated between
 * tenants (the same bucket in two tenants is two counters), exact admission under concurrency,
 * and refusal without a tenant.
 */

import { runRateLimiterContract } from "../contract/rate-limiter-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { PostgresRateLimiter } from "@/platform/rate-limit/postgres-limiter";
import { createRateLimiter } from "@/platform/rate-limit/factory";
import type { RateLimitRule } from "@/platform/rate-limit/types";
import { TenantContextError, runWithoutTenant } from "@/platform/tenancy/context";
import { withOwnerTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
} from "../helpers/db";

const RULE: RateLimitRule = { id: "db:rule", maxRequests: 5, windowSeconds: 60 };

dbDescribe("PostgresRateLimiter", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runRateLimiterContract({
    makeLimiter: async () =>
      inTenant(new PostgresRateLimiter(), await createTestTenant()),
    databaseClock: true,
  });

  runTenantIsolationContract({
    name: "rate_limit_events",
    makeStore: () => new PostgresRateLimiter(),
    createTenant: createTestTenant,
    write: async (l, key) => {
      await l.check(key, RULE);
    },
    read: async (l, key) => {
      const r = await l.peek(key, RULE);
      // The record is its count; resetAt moves with the clock, so it is not compared.
      return r.remaining < RULE.maxRequests
        ? { limit: r.limit, remaining: r.remaining }
        : null;
    },
    update: async (l, key) => {
      await l.check(key, RULE);
    },
    remove: async (l, key) => l.reset(key, RULE),
  });

  it("the same bucket in two tenants is two counters, and one tenant's limit never refuses the other", async () => {
    const limiter = new PostgresRateLimiter();
    const [a, b] = [await createTestTenant(), await createTestTenant()];
    const rule: RateLimitRule = { id: "db:two", maxRequests: 2, windowSeconds: 60 };
    for (let i = 0; i < 2; i++) await a.run(() => limiter.check("ip:same", rule));
    await expect(a.run(() => limiter.check("ip:same", rule))).resolves.toMatchObject({
      allowed: false,
    });
    await expect(b.run(() => limiter.check("ip:same", rule))).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
    // Both tenants' events carry the same bucket text; row-level security keeps them apart.
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ tenant_id: string; n: string }>(
        "select tenant_id, count(*) as n from rate_limit_events where bucket = $1 and tenant_id = any($2::uuid[]) group by tenant_id",
        ["rl:db:two:ip:same", [a.id, b.id]]
      )
    );
    expect(Object.fromEntries(rows.map((r) => [r.tenant_id, Number(r.n)]))).toEqual({
      [a.id]: 2,
      [b.id]: 1,
    });
  });

  it("N parallel hits admit exactly the limit", async () => {
    const tenant = await createTestTenant();
    const limiter = inTenant(new PostgresRateLimiter(), tenant);
    const rule: RateLimitRule = { id: "db:race", maxRequests: 7, windowSeconds: 60 };
    const results = await Promise.all(
      Array.from({ length: 25 }, () => limiter.check("ip:race", rule))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
    expect(results.filter((r) => !r.allowed).every((r) => r.retryAfterSeconds >= 1)).toBe(
      true
    );
    await expect(limiter.peek("ip:race", rule)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("reports the reset time from the database clock, as epoch seconds", async () => {
    const limiter = inTenant(new PostgresRateLimiter(), await createTestTenant());
    const before = Math.floor(Date.now() / 1000);
    const r = await limiter.check("ip:clock", RULE);
    expect(typeof r.resetAt).toBe("number");
    expect(r.resetAt).toBeGreaterThanOrEqual(before + RULE.windowSeconds - 2);
    expect(r.resetAt).toBeLessThanOrEqual(before + RULE.windowSeconds + 2);
  });

  it("uses the configured namespace in the bucket", async () => {
    const tenant = await createTestTenant();
    const limiter = inTenant(new PostgresRateLimiter({ namespace: "ns:" }), tenant);
    await limiter.check("ip:ns", RULE);
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ bucket: string }>(
        "select bucket from rate_limit_events where tenant_id = $1::uuid",
        [tenant.id]
      )
    );
    expect(rows.map((r) => r.bucket)).toEqual(["ns:db:rule:ip:ns"]);
  });

  it("throws when the database refuses the call (an invalid window)", async () => {
    const limiter = inTenant(new PostgresRateLimiter(), await createTestTenant());
    await expect(
      limiter.check("ip:a", { id: "db:bad", maxRequests: 1, windowSeconds: 86_401 })
    ).rejects.toThrow(/invalid window/);
  });

  it("does nothing without a tenant", async () => {
    const limiter = new PostgresRateLimiter();
    await runWithoutTenant(async () => {
      await expect(limiter.check("ip:a", RULE)).rejects.toThrow(TenantContextError);
      await expect(limiter.peek("ip:a", RULE)).rejects.toThrow(TenantContextError);
      await expect(limiter.reset("ip:a", RULE)).rejects.toThrow(TenantContextError);
    });
  });

  it("the factory builds it for postgres and supabase when a database is configured", () => {
    expect(createRateLimiter({ provider: "postgres" })).toBeInstanceOf(
      PostgresRateLimiter
    );
    expect(createRateLimiter({ provider: "supabase" }).name).toBe("postgres");
  });
});
