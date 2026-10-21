/**
 * enforceRateLimit and getClientIp (ADR-052 D1, D4, D5)
 */
import { NextRequest } from "next/server";
import {
  enforceRateLimit,
  getClientIp,
  setRateLimiter,
  InMemoryRateLimiter,
  type RateLimiter,
  type RateLimitRule,
} from "@/platform/rate-limit";

const RULE: RateLimitRule = { id: "test:rule", maxRequests: 2, windowSeconds: 60 };

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/thing", { method: "POST", headers });
}

describe("enforceRateLimit", () => {
  beforeEach(() => {
    setRateLimiter(new InMemoryRateLimiter({ cleanupIntervalMs: 0 }));
  });

  it("lets a request under the limit through", async () => {
    await expect(
      enforceRateLimit(req({ "x-forwarded-for": "203.0.113.7" }), RULE)
    ).resolves.toBeNull();
  });

  it("refuses over the limit with a coded 429 and the limit headers", async () => {
    const r = () => req({ "x-forwarded-for": "203.0.113.7" });
    await enforceRateLimit(r(), RULE);
    await enforceRateLimit(r(), RULE);
    const res = await enforceRateLimit(r(), RULE);
    expect(res?.status).toBe(429);
    const body = (await res?.json()) as {
      code: string;
      params: { retryAfterSeconds: number };
    };
    expect(body.code).toBe("rate.limited");
    expect(body.params.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(res?.headers.get("Retry-After")).toBe(String(body.params.retryAfterSeconds));
    expect(res?.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(res?.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res?.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);
  });

  it("counts by address before verification, so different addresses are separate", async () => {
    for (let i = 0; i < 2; i++)
      await enforceRateLimit(req({ "x-forwarded-for": "198.51.100.1" }), RULE);
    await expect(
      enforceRateLimit(req({ "x-forwarded-for": "198.51.100.2" }), RULE)
    ).resolves.toBeNull();
  });

  it("counts by verified actor when given one, whatever the address", async () => {
    for (let i = 0; i < 2; i++) {
      await enforceRateLimit(req({ "x-forwarded-for": `198.51.100.${i}` }), RULE, {
        actorId: "user-1",
      });
    }
    const res = await enforceRateLimit(req({ "x-forwarded-for": "198.51.100.9" }), RULE, {
      actorId: "user-1",
    });
    expect(res?.status).toBe(429);
    await expect(
      enforceRateLimit(req(), RULE, { actorId: "user-2" })
    ).resolves.toBeNull();
  });

  it("fails closed with a coded 503 when the store cannot answer", async () => {
    const broken: RateLimiter = {
      name: "broken",
      check: () => Promise.reject(new Error("db down")),
      peek: () => Promise.reject(new Error("db down")),
      reset: () => Promise.resolve(),
    };
    setRateLimiter(broken);
    const res = await enforceRateLimit(req(), RULE);
    expect(res?.status).toBe(503);
    const body = (await res?.json()) as { code: string; params: { service: string } };
    expect(body).toMatchObject({
      code: "service.unavailable",
      params: { service: "rate_limit" },
    });
    expect(JSON.stringify(body)).not.toContain("db down");
  });
});

describe("getClientIp", () => {
  it("takes the entry the trusted proxies added, not what the caller supplied", () => {
    const r = req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(getClientIp(r, 1)).toBe("203.0.113.7");
    expect(getClientIp(r, 2)).toBe("6.6.6.6");
  });

  it("uses the only entry when there are fewer entries than hops", () => {
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.7" }), 3)).toBe("203.0.113.7");
  });

  it("ignores empty entries and whitespace", () => {
    expect(getClientIp(req({ "x-forwarded-for": " , 203.0.113.7 , " }), 1)).toBe(
      "203.0.113.7"
    );
  });

  it("falls back to X-Real-IP, then to a shared 'unknown' bucket", () => {
    expect(getClientIp(req({ "x-real-ip": "192.0.2.4" }))).toBe("192.0.2.4");
    expect(getClientIp(req())).toBe("unknown");
  });

  it("reads TRUSTED_PROXY_HOPS by default", () => {
    const saved = process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUSTED_PROXY_HOPS = "2";
    try {
      expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe(
        "6.6.6.6"
      );
      process.env.TRUSTED_PROXY_HOPS = "not-a-number";
      expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe(
        "203.0.113.7"
      );
    } finally {
      if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = saved;
    }
  });
});

describe("routes are limited end to end", () => {
  beforeEach(() => {
    setRateLimiter(new InMemoryRateLimiter({ cleanupIntervalMs: 0 }));
  });

  it("sign-in refuses the eleventh attempt from one address within 15 minutes", async () => {
    const { POST } = await import("@/app/api/auth/sign-in/route");
    const attempt = () =>
      POST(
        new NextRequest("http://localhost/api/auth/sign-in", {
          method: "POST",
          headers: {
            "x-forwarded-for": "203.0.113.50",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        })
      );
    for (let i = 0; i < 10; i++) expect((await attempt()).status).not.toBe(429);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("rate.limited");
  });
});
