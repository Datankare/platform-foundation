/**
 * __tests__/daily-paid-quota.test.ts — the daily paid-request quota (audit X-12)
 *
 * Adversarial: the cap holds per verified actor whatever address or headers the caller sends; a
 * governed value that is missing, unreadable, fractional, zero, negative, huge or not a number
 * means the default, never "unlimited"; a failing limiter store refuses (503), never allows.
 */

jest.mock("@/platform/auth/platform-config", () => ({ getConfig: jest.fn() }));

import { NextRequest } from "next/server";
import { getConfig } from "@/platform/auth/platform-config";
import {
  DAILY_PAID_QUOTA_KEY,
  DEFAULT_DAILY_PAID_QUOTA,
  dailyPaidQuota,
  enforceDailyPaidQuota,
  InMemoryRateLimiter,
  setRateLimiter,
  type RateLimiter,
} from "@/platform/rate-limit";

const config = getConfig as jest.Mock;
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";

const req = (ip = "203.0.113.7") =>
  new NextRequest("http://localhost/api/process", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });

beforeEach(() => {
  config.mockReset().mockResolvedValue(3);
  setRateLimiter(new InMemoryRateLimiter({ cleanupIntervalMs: 0 }));
});

describe("dailyPaidQuota", () => {
  it("reads the governed key", async () => {
    expect(await dailyPaidQuota()).toBe(3);
    expect(config).toHaveBeenCalledWith(DAILY_PAID_QUOTA_KEY, DEFAULT_DAILY_PAID_QUOTA);
  });

  it.each([
    [0],
    [-1],
    [2.5],
    [10_001],
    [Number.POSITIVE_INFINITY],
    [NaN],
    ["500"],
    [null],
    [{}],
    [[200]],
  ])("uses the default for %p", async (bad) => {
    config.mockResolvedValue(bad);
    expect(await dailyPaidQuota()).toBe(DEFAULT_DAILY_PAID_QUOTA);
  });

  it("uses the default when the setting cannot be read", async () => {
    config.mockRejectedValue(new Error("db down"));
    expect(await dailyPaidQuota()).toBe(DEFAULT_DAILY_PAID_QUOTA);
  });
});

describe("enforceDailyPaidQuota", () => {
  it("allows up to the cap, then refuses with a coded 429", async () => {
    for (let i = 0; i < 3; i++) expect(await enforceDailyPaidQuota(req(), A)).toBeNull();
    const res = await enforceDailyPaidQuota(req(), A);
    expect(res?.status).toBe(429);
    expect((await res!.json()).code).toBe("rate.limited");
    expect(res!.headers.get("X-RateLimit-Limit")).toBe("3");
  });

  it("counts by actor: a new address does not reset it, another actor is separate", async () => {
    for (let i = 0; i < 3; i++) await enforceDailyPaidQuota(req(`198.51.100.${i}`), A);
    expect((await enforceDailyPaidQuota(req("192.0.2.99"), A))?.status).toBe(429);
    expect(await enforceDailyPaidQuota(req(), B)).toBeNull();
  });

  it("is separate from the per-minute AI limit's counter", async () => {
    const seen: string[] = [];
    const limiter: RateLimiter = {
      check: jest.fn(async (id: string) => {
        seen.push(id);
        return { allowed: true, limit: 3, remaining: 2, resetAt: Date.now() + 1000 };
      }),
    } as unknown as RateLimiter;
    setRateLimiter(limiter);
    await enforceDailyPaidQuota(req(), A);
    expect((limiter.check as jest.Mock).mock.calls[0][1]).toMatchObject({
      id: "ai:daily-paid",
      maxRequests: 3,
      windowSeconds: 86_400,
    });
    expect(seen[0]).toContain(A);
  });

  it("refuses (503), not allows, when the limiter store fails", async () => {
    setRateLimiter({
      check: jest.fn(async () => {
        throw new Error("store down");
      }),
    } as unknown as RateLimiter);
    const res = await enforceDailyPaidQuota(req(), A);
    expect(res?.status).toBe(503);
  });
});
