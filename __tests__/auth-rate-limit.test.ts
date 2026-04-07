/**
 * platform/auth/rate-limit.ts — Integrity tests
 *
 * This is production security infrastructure called by every API route.
 * Zero coverage = untested protection on every endpoint.
 */

import { NextRequest } from "next/server";
import {
  checkRateLimit,
  getRateLimitStatus,
  clearRateLimitStore,
  getRateLimitStoreSize,
} from "@/platform/auth/rate-limit";
import type { RateLimitConfig } from "@/platform/auth/rate-limit";

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

function makeRequest(ip = "192.168.1.1"): NextRequest {
  const req = new NextRequest("http://localhost/api/test", {
    headers: { "x-forwarded-for": ip },
  });
  return req;
}

afterEach(() => {
  clearRateLimitStore();
});

describe("checkRateLimit — allows requests under limit", () => {
  const config: RateLimitConfig = { windowMs: 60_000, maxRequests: 3 };

  it("returns null (allowed) for first request", () => {
    const result = checkRateLimit(makeRequest(), config);
    expect(result).toBeNull();
  });

  it("returns null up to maxRequests", () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(makeRequest(), config)).toBeNull();
    }
  });
});

describe("checkRateLimit — blocks requests over limit", () => {
  const config: RateLimitConfig = { windowMs: 60_000, maxRequests: 2 };

  it("returns 429 when limit exceeded", () => {
    checkRateLimit(makeRequest(), config);
    checkRateLimit(makeRequest(), config);
    const result = checkRateLimit(makeRequest(), config);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it("includes Retry-After header", async () => {
    checkRateLimit(makeRequest(), config);
    checkRateLimit(makeRequest(), config);
    const result = checkRateLimit(makeRequest(), config)!;

    expect(result.headers.get("Retry-After")).toBeTruthy();
  });

  it("includes X-RateLimit-Limit header", async () => {
    checkRateLimit(makeRequest(), config);
    checkRateLimit(makeRequest(), config);
    const result = checkRateLimit(makeRequest(), config)!;

    expect(result.headers.get("X-RateLimit-Limit")).toBe("2");
  });

  it("includes X-RateLimit-Remaining as 0", async () => {
    checkRateLimit(makeRequest(), config);
    checkRateLimit(makeRequest(), config);
    const result = checkRateLimit(makeRequest(), config)!;

    expect(result.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("returns error body with retryAfter", async () => {
    checkRateLimit(makeRequest(), config);
    checkRateLimit(makeRequest(), config);
    const result = checkRateLimit(makeRequest(), config)!;
    const body = await result.json();

    expect(body.error).toBe("Too many requests");
    expect(body.retryAfter).toBeGreaterThan(0);
  });
});

describe("checkRateLimit — IP extraction", () => {
  it("extracts IP from x-forwarded-for", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2" },
    });
    const config: RateLimitConfig = { windowMs: 60_000, maxRequests: 1 };

    checkRateLimit(req, config);
    expect(getRateLimitStoreSize()).toBe(1);
  });

  it("extracts IP from x-real-ip when x-forwarded-for absent", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-real-ip": "172.16.0.1" },
    });
    const config: RateLimitConfig = { windowMs: 60_000, maxRequests: 1 };

    checkRateLimit(req, config);
    expect(getRateLimitStoreSize()).toBe(1);
  });

  it("uses 'unknown' when no IP headers present", () => {
    const req = new NextRequest("http://localhost/api/test");
    const config: RateLimitConfig = { windowMs: 60_000, maxRequests: 1 };

    checkRateLimit(req, config);
    expect(getRateLimitStoreSize()).toBe(1);
  });
});

describe("checkRateLimit — tracks different IPs independently", () => {
  const config: RateLimitConfig = { windowMs: 60_000, maxRequests: 1 };

  it("allows requests from different IPs", () => {
    expect(checkRateLimit(makeRequest("10.0.0.1"), config)).toBeNull();
    expect(checkRateLimit(makeRequest("10.0.0.2"), config)).toBeNull();
  });

  it("blocks one IP without blocking another", () => {
    checkRateLimit(makeRequest("10.0.0.1"), config);
    expect(checkRateLimit(makeRequest("10.0.0.1"), config)).not.toBeNull();
    expect(checkRateLimit(makeRequest("10.0.0.2"), config)).toBeNull();
  });
});

describe("checkRateLimit — window expiry", () => {
  it("allows requests after window expires", () => {
    jest.useFakeTimers();
    const config: RateLimitConfig = { windowMs: 5_000, maxRequests: 1 };

    checkRateLimit(makeRequest(), config);
    expect(checkRateLimit(makeRequest(), config)).not.toBeNull();

    jest.advanceTimersByTime(6_000);
    expect(checkRateLimit(makeRequest(), config)).toBeNull();

    jest.useRealTimers();
  });
});

describe("getRateLimitStatus", () => {
  it("returns full quota for unknown IP", () => {
    const status = getRateLimitStatus("new-ip");
    expect(status.remaining).toBe(60);
    expect(status.limit).toBe(60);
    expect(status.resetAt).toBeGreaterThan(0);
  });

  it("decrements remaining after requests", () => {
    const config: RateLimitConfig = { windowMs: 60_000, maxRequests: 5 };
    checkRateLimit(makeRequest("10.0.0.1"), config);
    checkRateLimit(makeRequest("10.0.0.1"), config);

    const status = getRateLimitStatus("10.0.0.1", config);
    expect(status.remaining).toBe(3);
  });
});

describe("clearRateLimitStore", () => {
  it("clears all entries", () => {
    checkRateLimit(makeRequest("10.0.0.1"));
    checkRateLimit(makeRequest("10.0.0.2"));
    expect(getRateLimitStoreSize()).toBe(2);

    clearRateLimitStore();
    expect(getRateLimitStoreSize()).toBe(0);
  });
});
