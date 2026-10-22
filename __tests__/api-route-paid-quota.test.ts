/**
 * __tests__/api-route-paid-quota.test.ts — every paid call is counted against a daily quota (audit X-12)
 *
 * The per-minute limit bounds bursts, not spend. A route that makes a paid provider call must
 * call enforceDailyPaidQuota, with the verified actor, before its first paid call — or be listed
 * as exempt with the reason. The app declares its own paid functions (and exemptions) in
 * platform/route-policy/app-route-policy.ts, so a consumer's speech or song-ID routes are held
 * to the same rule.
 */

import { APP_ROUTE_POLICY } from "@/platform/route-policy/app-route-policy";
import {
  apiRoutes,
  definitionBody,
  productionSources,
  read,
} from "./helpers/route-policy";

/** The platform's functions that make a paid provider call. */
const PLATFORM_PAID_CALLS = [
  "checkSafety",
  "classifyContent",
  "screenContent",
  "screenMultimodalInput",
  "checkOutputSafety",
  "translateText",
  "translateToAllLanguages",
  "textToSpeech",
  "getOrchestrator",
  "createOrchestrator",
  "generateGoverned",
];

const DECLARED = [...PLATFORM_PAID_CALLS, ...(APP_ROUTE_POLICY.paidCalls ?? [])];
const EXEMPT: Readonly<Record<string, string>> = APP_ROUTE_POLICY.paidQuotaExempt ?? {};
const QUOTA = /\benforceDailyPaidQuota\s*\(/;

/** Source without comments, so a comment naming a call does not count as one. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Each exported function declaration in `src`, with its definition (signature and body). */
function exportedBodies(src: string): { name: string; body: string }[] {
  return [...src.matchAll(/^export\s+(?:async\s+)?function\*?\s+(\w+)/gm)].map((m) => ({
    name: m[1],
    body: definitionBody(src, m[1]).replace(new RegExp(`function\\*?\\s+${m[1]}`), ""),
  }));
}

const callsAny = (src: string, names: Iterable<string>): boolean =>
  [...names].some((n) => new RegExp(`\\b${n}\\s*\\(`).test(src));

/**
 * Every function that makes a paid call, directly or through another: the declared paid
 * functions, then — to a fixed point — every exported function (outside the routes) whose body
 * calls one. A route that reaches a paid call through a helper module is held to the rule too
 * (release review: the reviewer-assist route was not, because its paid call was one module away).
 * Limit: exported function declarations only; a paid call made from a class method or an
 * exported arrow function is found only when declared in app-route-policy.ts `paidCalls`.
 */
function paidClosure(): string[] {
  const names = new Set(DECLARED);
  const modules = productionSources()
    .filter((f) => !/^app\/api\/.*\/route\.ts$/.test(f))
    .map((f) => exportedBodies(code(read(f))));
  let grew = true;
  while (grew) {
    grew = false;
    for (const fns of modules) {
      for (const { name, body } of fns) {
        if (!names.has(name) && callsAny(body, names)) {
          names.add(name);
          grew = true;
        }
      }
    }
  }
  return [...names];
}

const PAID = paidClosure();

/** Offset of the first call to any of `names` in `src`, or -1. */
function firstCall(src: string, names: readonly string[]): number {
  const hits = names
    .map((n) => src.search(new RegExp(`\\b${n}\\s*\\(`)))
    .filter((i) => i >= 0);
  return hits.length ? Math.min(...hits) : -1;
}

/** Why a route breaks the rule, or null. */
function quotaProblem(raw: string, paid: readonly string[] = PAID): string | null {
  const src = code(raw);
  const firstPaid = firstCall(src, paid);
  if (firstPaid < 0) return null;
  const quota = src.search(QUOTA);
  if (quota < 0) return "makes a paid call without enforceDailyPaidQuota";
  if (quota > firstPaid) return "counts the quota only after a paid call";
  return null;
}

const ROUTES = apiRoutes();
const PAID_ROUTES = ROUTES.filter((f) => firstCall(code(read(f)), PAID) >= 0);

describe("daily paid-request quota on every paid route (audit X-12)", () => {
  it("finds the platform's paid routes (self-test before any absence counts)", () => {
    expect(PAID_ROUTES).toEqual(
      expect.arrayContaining([
        "app/api/process/route.ts",
        "app/api/stream/route.ts",
        "app/api/admin/ai/route.ts",
        "app/api/moderation/review/[id]/assist/route.ts",
      ])
    );
  });

  it("follows a paid call through helper modules (self-test of the closure)", () => {
    expect(PAID).toContain("generateReviewRecommendation");
  });

  it("every paid route counts the call before making it, or is exempt", () => {
    const problems = PAID_ROUTES.filter((f) => !EXEMPT[f])
      .map((f) => ({ f, problem: quotaProblem(read(f)) }))
      .filter((p) => p.problem);
    expect(problems).toEqual([]);
  });

  it("lists no exempt route that does not exist, and gives each a reason", () => {
    for (const [f, reason] of Object.entries(EXEMPT)) {
      expect({
        f,
        exists: ROUTES.includes(f),
        reason: reason.trim().length > 10,
      }).toEqual({
        f,
        exists: true,
        reason: true,
      });
    }
  });

  it.each([
    ["no quota", "export async function POST(r) { await checkSafety(t); }"],
    [
      "the quota after the paid call",
      "export async function POST(r) { await textToSpeech(t); await enforceDailyPaidQuota(r, id); }",
    ],
  ])("the checker catches %s", (_label, src) => {
    expect(quotaProblem(src)).not.toBeNull();
  });

  it("the checker accepts the quota before the paid call, and ignores unpaid routes", () => {
    expect(
      quotaProblem(
        "export async function POST(r) { await enforceDailyPaidQuota(r, id); await checkSafety(t); }"
      )
    ).toBeNull();
    expect(quotaProblem("export async function GET() { return ok(); }")).toBeNull();
    expect(
      quotaProblem(
        "// before checkSafety(t)\nexport async function GET() { return ok(); }"
      )
    ).toBeNull();
  });
});
