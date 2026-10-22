/**
 * __tests__/api-route-rate-limit.test.ts — Every API route is rate limited (ADR-052, TASK-134)
 *
 * The shared limiter existed for months while no route called it (TASK-134). This test makes the
 * rule mechanical: each route handler must call enforceRateLimit, or adminGuard or requireAdmin
 * (which call it),
 * or the route must be listed as exempt with the reason.
 *
 * An app's own limiter wrappers and exemptions are declared in
 * platform/route-policy/app-route-policy.ts (TASK-136); each wrapper must itself call
 * enforceRateLimit, directly or through another declared wrapper.
 */

import { APP_ROUTE_POLICY } from "@/platform/route-policy/app-route-policy";
import {
  apiRoutes,
  callCount,
  handlerCount,
  read,
  resolveDeclared,
} from "./helpers/route-policy";

const PLATFORM_LIMITERS = ["enforceRateLimit", "adminGuard", "requireAdmin"];

/** The platform's routes not rate limited, by design. Each needs a reason. */
const PLATFORM_EXEMPT: Readonly<Record<string, string>> = {
  "app/api/health/route.ts":
    "Liveness must not depend on the limiter's own store; it reads no user data, and its one paid probe (song ID) runs at most once per 15 minutes per instance (CachedHealthProbe, audit X-13).",
};

const ROUTES = apiRoutes();
const EXEMPT: Readonly<Record<string, string>> = {
  ...PLATFORM_EXEMPT,
  ...APP_ROUTE_POLICY.rateLimitExempt,
};
const LIMITERS = resolveDeclared(PLATFORM_LIMITERS, APP_ROUTE_POLICY.limiters);

describe("API route rate limiting (ADR-052)", () => {
  it("finds a plausible number of routes (self-test before any absence counts)", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it("accepts each declared app limiter only if it calls enforceRateLimit", () => {
    expect(LIMITERS.problems).toEqual([]);
  });

  it("every handler in every route is rate limited, or the route is exempt", () => {
    const missing = ROUTES.filter((f) => !EXEMPT[f]).filter((f) => {
      const src = read(f);
      return callCount(src, LIMITERS.accepted) < handlerCount(src);
    });
    expect(missing).toEqual([]);
  });

  it("lists no exempt route that does not exist, and gives each a reason", () => {
    for (const [f, reason] of Object.entries(EXEMPT)) {
      expect({
        f,
        exists: ROUTES.includes(f),
        hasReason: reason.trim().length > 10,
      }).toEqual({
        f,
        exists: true,
        hasReason: true,
      });
    }
  });

  it("the checker catches a handler without a limit", () => {
    const src =
      "export async function GET(request) { const l = await enforceRateLimit(request, R); }\n" +
      "export async function POST() { return new Response('open'); }";
    expect(callCount(src, PLATFORM_LIMITERS)).toBeLessThan(handlerCount(src));
  });
});
