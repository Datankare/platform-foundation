/**
 * __tests__/contract/rate-limiter-contract.ts — RateLimiter conformance (ADR-027, ADR-052)
 *
 * What every rate-limit store must guarantee for a limit to hold:
 *   - it admits up to the limit and refuses after it, reporting how long to wait;
 *   - peeking never counts;
 *   - callers and rules are counted independently;
 *   - concurrent checks never admit more than the limit;
 *   - requests age out of the window; reset forgets a caller.
 */

import type { RateLimiter, RateLimitRule } from "@/platform/rate-limit";

export interface RateLimiterContractFixtures {
  /** Fresh, empty limiter per test. */
  makeLimiter: () => RateLimiter | Promise<RateLimiter>;
}

const RULE: RateLimitRule = { id: "kit:rule", maxRequests: 3, windowSeconds: 60 };
const OTHER: RateLimitRule = { id: "kit:other", maxRequests: 3, windowSeconds: 60 };

export function runRateLimiterContract(fx: RateLimiterContractFixtures): void {
  let limiter: RateLimiter;

  beforeEach(async () => {
    limiter = await fx.makeLimiter();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("admits up to the limit, counting down what remains", async () => {
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await limiter.check("ip:a", RULE));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0]);
    expect(results.every((r) => r.limit === 3 && r.retryAfterSeconds === 0)).toBe(true);
  });

  it("refuses after the limit and says how long to wait", async () => {
    for (let i = 0; i < 3; i++) await limiter.check("ip:a", RULE);
    const refused = await limiter.check("ip:a", RULE);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(RULE.windowSeconds);
  });

  it("peeking never counts", async () => {
    const before = await limiter.peek("ip:a", RULE);
    expect(before).toMatchObject({ allowed: true, remaining: 3 });
    await limiter.peek("ip:a", RULE);
    await limiter.check("ip:a", RULE);
    await expect(limiter.peek("ip:a", RULE)).resolves.toMatchObject({ remaining: 2 });
  });

  it("counts callers independently", async () => {
    for (let i = 0; i < 3; i++) await limiter.check("ip:a", RULE);
    await expect(limiter.check("ip:b", RULE)).resolves.toMatchObject({ allowed: true });
  });

  it("counts rules independently for one caller", async () => {
    for (let i = 0; i < 3; i++) await limiter.check("ip:a", RULE);
    await expect(limiter.check("ip:a", OTHER)).resolves.toMatchObject({ allowed: true });
  });

  it("concurrent checks never admit more than the limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.check("ip:race", RULE))
    );
    const admitted = results.filter((r) => r.allowed).length;
    expect(admitted).toBeGreaterThanOrEqual(1);
    expect(admitted).toBeLessThanOrEqual(3);
  });

  it("requests age out of the window", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-20T12:00:00Z") });
    for (let i = 0; i < 3; i++) await limiter.check("ip:a", RULE);
    await expect(limiter.check("ip:a", RULE)).resolves.toMatchObject({ allowed: false });
    jest.setSystemTime(new Date("2026-10-20T12:01:01Z"));
    await expect(limiter.check("ip:a", RULE)).resolves.toMatchObject({ allowed: true });
  });

  it("reset forgets a caller for that rule", async () => {
    for (let i = 0; i < 3; i++) await limiter.check("ip:a", RULE);
    await limiter.reset("ip:a", RULE);
    await expect(limiter.check("ip:a", RULE)).resolves.toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });
}
