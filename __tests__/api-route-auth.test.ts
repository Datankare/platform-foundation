/**
 * __tests__/api-route-auth.test.ts — Every API route verifies its caller
 *
 * @guard a route method that does not verify its caller first
 *
 * The proxy (proxy.ts) only checks that credentials are PRESENT on /api/* and leaves
 * verification to the route handler. A handler that forgets to verify is therefore open to any
 * request carrying "Authorization: Bearer <anything>" — which is how /api/stream ran
 * unauthenticated until 2026-10 (TASK-133). This test makes the rule mechanical: each route
 * file must call a verifier, or be listed as public by design, with the reason.
 *
 * An app's own verifier wrappers and public routes are declared in
 * platform/route-policy/app-route-policy.ts (TASK-136); each wrapper must itself call a platform
 * verifier, directly or through another declared wrapper.
 *
 * Per method, not per file (TASK-194, audit C-11): a file passed when any of its methods verified,
 * so an `export const DELETE` that only rate limits, added beside a verified POST, passed. Each
 * exported method is read with the compiler API (helpers/route-methods.ts): its own body must call
 * a verifier, and await nothing but a limiter before it.
 */

import { APP_ROUTE_POLICY } from "@/platform/route-policy/app-route-policy";
import {
  apiRoutes,
  callCount,
  isWrapperSource,
  read,
  resolveDeclared,
} from "./helpers/route-policy";
import { routeMethods, verificationProblem } from "./helpers/route-methods";

/**
 * The platform's verifiers: token signature, guest signature, admin permission — or, for the
 * host's job tick only, the CRON_SECRET bearer (platform/jobs/tick-auth.ts, ADR-056 D2).
 */
const PLATFORM_VERIFIERS = [
  "requireActorWithStatus",
  "requireActor",
  "requireAuth",
  "adminGuard",
  "requireAdmin",
  "requireJobTick",
];

/**
 * The platform's route methods with no verifier, by design ("file METHOD"). Each needs a reason.
 */
const PLATFORM_PUBLIC: Readonly<Record<string, string>> = {
  "app/api/health/route.ts GET":
    "The combined health report for existing monitors; names and statuses only, no user data.",
  "app/api/health/live/route.ts GET":
    "Liveness for orchestrators (ADR-056 D4): the process answers; no dependency, no user data.",
  "app/api/health/ready/route.ts GET":
    "Readiness for load balancers and the deploy smoke test (ADR-056 D4); names and statuses only.",
  "app/api/features/route.ts GET":
    "Which optional features exist; read by the sign-in screen.",
  "app/api/auth/sign-in/route.ts POST": "Establishes the session.",
  "app/api/auth/sign-up/route.ts POST": "Creates the account.",
  "app/api/auth/sign-out/route.ts POST":
    "Ends the session the cookie names (resolveSession: this origin, the session's token); without one there is nothing to end.",
  "app/api/auth/session/migrate/route.ts POST":
    "Moves a pre-ADR-057 browser onto a server-side session; the httpOnly legacy cookie (MAC-checked) is the credential, exchanged with the provider.",
  "app/api/auth/guest/route.ts POST": "Mints a signed guest token (ADR-050 D4).",
  "app/api/auth/forgot-password/route.ts POST": "Account recovery before sign-in.",
  "app/api/auth/confirm-forgot-password/route.ts POST":
    "Account recovery before sign-in.",
  "app/api/auth/verify-email/route.ts POST": "Email verification before first sign-in.",
  "app/api/auth/resend-verification/route.ts POST":
    "Email verification before first sign-in.",
  "app/api/auth/mfa-challenge/route.ts POST":
    "Second step of sign-in; the challenge session is the credential.",
  "app/api/auth/new-password-challenge/route.ts POST":
    "Forced password change during sign-in; the challenge session is the credential.",
  "app/api/auth/sso/[provider]/route.ts GET": "Starts hosted sign-in (state + PKCE).",
  "app/api/auth/sso/callback/route.ts POST":
    "Completes hosted sign-in; verifies state and PKCE.",
};

const ROUTES = apiRoutes();
const PUBLIC: Readonly<Record<string, string>> = {
  ...PLATFORM_PUBLIC,
  ...APP_ROUTE_POLICY.publicRoutes,
};
const VERIFIERS = resolveDeclared(PLATFORM_VERIFIERS, APP_ROUTE_POLICY.verifiers);
/** What a method may await before it verifies: the limiters (ADR-052). */
const LIMITERS = resolveDeclared(
  ["enforceRateLimit"],
  APP_ROUTE_POLICY.limiters
).accepted;

describe("API route caller verification (TASK-133)", () => {
  it("finds a plausible number of routes (self-test before any absence counts)", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it("accepts each declared app verifier only if it calls a platform verifier", () => {
    expect(VERIFIERS.problems).toEqual([]);
  });

  it("every method of every route verifies its caller first, or the route is public by design", () => {
    const unverified: string[] = [];
    let methods = 0;
    for (const f of ROUTES) {
      const found = routeMethods(read(f), f);
      if (found.length === 0) unverified.push(`${f}: no exported method found`);
      for (const m of found) {
        // Public per (file, method) (TASK-194 round 1, A4): a method added beside a public one
        // is not public with it.
        if (PUBLIC[`${f} ${m.method}`]) continue;
        methods += 1;
        const problem = verificationProblem(m, VERIFIERS.accepted, LIMITERS);
        if (problem) unverified.push(`${f} ${m.method}: ${problem}`);
      }
    }
    expect(unverified).toEqual([]);
    expect(methods).toBeGreaterThan(ROUTES.length - Object.keys(PUBLIC).length - 1);
  });

  it("lists no public method that does not exist, and gives each a reason", () => {
    const all = ROUTES.flatMap((f) =>
      routeMethods(read(f), f).map((m) => `${f} ${m.method}`)
    );
    for (const [f, reason] of Object.entries(PUBLIC)) {
      expect({
        f,
        exists: all.includes(f),
        hasReason: reason.trim().length > 10,
      }).toEqual({
        f,
        exists: true,
        hasReason: true,
      });
    }
  });
});

describe("route verification — self-tests of the checker", () => {
  const problems = (src: string) =>
    routeMethods(src).map((m) => [
      m.method,
      verificationProblem(m, PLATFORM_VERIFIERS, ["enforceRateLimit"]),
    ]);

  it("[self-test] judges each method by its own body: a verified POST does not cover an added DELETE (C-11)", () => {
    const src =
      "export const POST = tenantRoute(async function POST(request) {\n" +
      "  const g = await requireAdmin(request, 'admin_manage_roles'); return g; });\n" +
      "export const DELETE = tenantRoute(async function DELETE(request) {\n" +
      "  const l = await enforceRateLimit(request, R); return new Response('open'); });";
    expect(callCount(src, PLATFORM_VERIFIERS)).toBe(1); // the old file-level count passed it
    expect(problems(src)).toEqual([
      ["POST", null],
      ["DELETE", "calls no verifier"],
    ]);
  });

  it("refuses work awaited before the caller is verified; a limiter first is allowed", () => {
    const src =
      "export async function GET(request) { await enforceRateLimit(request, R);\n" +
      "  const a = await requireAuth(request); }\n" +
      "export async function POST(request) { const body = await readJsonObject(request);\n" +
      "  const a = await requireAuth(request); }";
    expect(problems(src)).toEqual([
      ["GET", null],
      ["POST", "awaits readJsonObject before verifying"],
    ]);
  });

  it("follows a method into the same file's helper, and reads a named handler", () => {
    const src =
      "async function guard(request) { return requireAdmin(request, 'x'); }\n" +
      "async function handle(request) { const g = await guard(request); return g; }\n" +
      "export const GET = tenantRoute(handle);\n" +
      "export { PUT } from './elsewhere';";
    expect(problems(src)).toEqual([
      ["GET", null],
      ["PUT", "its body could not be read"],
    ]);
  });

  it("catches a route with no verifier", () => {
    expect(
      callCount(
        "export async function POST() { return new Response('open'); }",
        PLATFORM_VERIFIERS
      )
    ).toBe(0);
  });

  it("accepts a declared wrapper that calls a platform verifier, even through another wrapper", () => {
    const defs = (name: string) =>
      ({
        guardA: [
          {
            file: "lib/a.ts",
            source:
              "export async function guardA(r) { return requireActorWithStatus(r); }",
          },
        ],
        guardB: [
          {
            file: "lib/b.ts",
            source: "export async function guardB(r) { return guardA(r); }",
          },
        ],
      })[name] ?? [];
    const r = resolveDeclared(PLATFORM_VERIFIERS, ["guardB", "guardA"], defs);
    expect(r.problems).toEqual([]);
    expect(r.accepted).toEqual(expect.arrayContaining(["guardA", "guardB"]));
  });

  it("refuses a declared wrapper that verifies nothing, or that cannot be found", () => {
    const defs = (name: string) =>
      name === "fake"
        ? [{ file: "lib/f.ts", source: "export function fake() { return true; }" }]
        : [];
    const r = resolveDeclared(PLATFORM_VERIFIERS, ["fake", "missing"], defs);
    expect(r.accepted).not.toContain("fake");
    expect(r.problems).toEqual([
      "missing: no definition found",
      "fake: its definition calls no platform function (or accepted wrapper)",
    ]);
  });

  it("judges a wrapper by its own body: a call elsewhere in its file, or in a comment, does not count", () => {
    const defs = (name: string) =>
      name === "fake"
        ? [
            {
              file: "lib/f.ts",
              source:
                "// requireAuth(request) is called by the real guard\n" +
                "export function fake() { return true; }\n" +
                "export async function other(r) { return requireAuth(r); }",
            },
          ]
        : [];
    const r = resolveDeclared(PLATFORM_VERIFIERS, ["fake"], defs);
    expect(r.accepted).not.toContain("fake");
  });

  it("looks for wrapper definitions in source only — never in tests or Jest manual mocks", () => {
    expect(isWrapperSource("lib/route-guard.ts")).toBe(true);
    expect(isWrapperSource("lib/__mocks__/route-guard.ts")).toBe(false);
    expect(isWrapperSource("lib/__tests__/route-guard.ts")).toBe(false);
    expect(isWrapperSource("lib/route-guard.test.ts")).toBe(false);
    expect(isWrapperSource("lib/route-guard.md")).toBe(false);
  });
});
