/**
 * __tests__/api-route-rate-limit.test.ts — Every API route is rate limited (ADR-052, TASK-134)
 *
 * The shared limiter existed for months while no route called it (TASK-134). This test makes the
 * rule mechanical: each route file must call enforceRateLimit, or adminGuard (which calls it),
 * or be listed below as exempt with the reason.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "app", "api");

const LIMITERS = [/\benforceRateLimit\s*\(/, /\badminGuard\s*\(/];

/** Routes not rate limited, by design. Each needs a reason; a stale entry fails the test. */
const EXEMPT: Readonly<Record<string, string>> = {
  "app/api/health/route.ts":
    "Liveness must not depend on the limiter's own store; it reads no user data and makes no paid call.",
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(relative(ROOT, p).split("\\").join("/"));
  }
  return out;
}

const ROUTES = routeFiles(API_DIR).sort();

/** Exported handlers in a route file (GET, POST, …). */
function handlerCount(src: string): number {
  return [
    ...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g),
  ].length;
}

describe("API route rate limiting (ADR-052)", () => {
  it("finds a plausible number of routes (self-test before any absence counts)", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it("every handler in every route is rate limited, or the route is exempt", () => {
    const missing = ROUTES.filter((f) => !EXEMPT[f]).flatMap((f) => {
      const src = readFileSync(join(ROOT, f), "utf-8");
      const calls = LIMITERS.reduce(
        (n, re) => n + (src.match(new RegExp(re, "g"))?.length ?? 0),
        0
      );
      return calls >= handlerCount(src) ? [] : [f];
    });
    expect(missing).toEqual([]);
  });

  it("lists no exempt route that no longer exists, and gives each a reason", () => {
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

  it("the self-test catches a handler without a limit", () => {
    const src =
      "export async function GET(request) { const l = await enforceRateLimit(request, R); }\n" +
      "export async function POST() { return new Response('open'); }";
    const calls = LIMITERS.reduce(
      (n, re) => n + (src.match(new RegExp(re, "g"))?.length ?? 0),
      0
    );
    expect(calls).toBeLessThan(handlerCount(src));
  });
});
