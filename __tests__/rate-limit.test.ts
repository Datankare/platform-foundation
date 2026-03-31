/**
 * Sprint 6 — Rate limiter tests
 */

import {
  checkRateLimit,
  getRateLimitStatus,
  clearRateLimitStore,
  getRateLimitStoreSize,
} from "@/platform/auth/rate-limit";
import { NextRequest } from "next/server";

function makeRequest(ip: string = "1.2.3.4"): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    headers: { "x-forwarded-for": ip },
  });
}

describe("checkRateLimit", () => {
  beforeEach(() => {
    clearRateLimitStore();
  });

  it("allows requests under the limit", () => {
    const req = makeRequest();
    const result = checkRateLimit(req, { windowMs: 60000, maxRequests: 10 });
    expect(result).toBeNull();
  });

  it("returns 429 when limit exceeded", () => {
    const config = { windowMs: 60000, maxRequests: 3 };
    for (let i = 0; i < 3; i++) {
      checkRateLimit(makeRequest(), config);
    }
    const result = checkRateLimit(makeRequest(), config);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it("tracks different IPs independently", () => {
    const config = { windowMs: 60000, maxRequests: 2 };
    checkRateLimit(makeRequest("1.1.1.1"), config);
    checkRateLimit(makeRequest("1.1.1.1"), config);

    const blocked = checkRateLimit(makeRequest("1.1.1.1"), config);
    expect(blocked).not.toBeNull();

    const allowed = checkRateLimit(makeRequest("2.2.2.2"), config);
    expect(allowed).toBeNull();
  });

  it("includes Retry-After header in 429 response", () => {
    const config = { windowMs: 60000, maxRequests: 1 };
    checkRateLimit(makeRequest(), config);
    const result = checkRateLimit(makeRequest(), config);
    expect(result!.headers.get("Retry-After")).toBe("60");
  });

  it("includes rate limit headers", () => {
    const config = { windowMs: 60000, maxRequests: 1 };
    checkRateLimit(makeRequest(), config);
    const result = checkRateLimit(makeRequest(), config);
    expect(result!.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("extracts IP from x-real-ip when x-forwarded-for missing", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-real-ip": "5.5.5.5" },
    });
    const config = { windowMs: 60000, maxRequests: 1 };
    checkRateLimit(req, config);
    const status = getRateLimitStatus("5.5.5.5", config);
    expect(status.remaining).toBe(0);
  });

  it("uses unknown when no IP headers present", () => {
    const req = new NextRequest("http://localhost/api/test");
    const config = { windowMs: 60000, maxRequests: 1 };
    checkRateLimit(req, config);
    const status = getRateLimitStatus("unknown", config);
    expect(status.remaining).toBe(0);
  });
});

describe("getRateLimitStatus", () => {
  beforeEach(() => {
    clearRateLimitStore();
  });

  it("returns full remaining for unknown IP", () => {
    const status = getRateLimitStatus("9.9.9.9");
    expect(status.remaining).toBe(60);
    expect(status.limit).toBe(60);
  });

  it("decrements remaining after requests", () => {
    const config = { windowMs: 60000, maxRequests: 10 };
    checkRateLimit(makeRequest("3.3.3.3"), config);
    checkRateLimit(makeRequest("3.3.3.3"), config);
    const status = getRateLimitStatus("3.3.3.3", config);
    expect(status.remaining).toBe(8);
  });
});

describe("rate limit store management", () => {
  beforeEach(() => {
    clearRateLimitStore();
  });

  it("clearRateLimitStore empties the store", () => {
    checkRateLimit(makeRequest());
    expect(getRateLimitStoreSize()).toBeGreaterThan(0);
    clearRateLimitStore();
    expect(getRateLimitStoreSize()).toBe(0);
  });

  it("getRateLimitStoreSize returns correct count", () => {
    checkRateLimit(makeRequest("1.1.1.1"));
    checkRateLimit(makeRequest("2.2.2.2"));
    expect(getRateLimitStoreSize()).toBe(2);
  });
});
