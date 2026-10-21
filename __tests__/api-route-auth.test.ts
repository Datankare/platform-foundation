/**
 * __tests__/api-route-auth.test.ts — Every API route verifies its caller
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
 */

import { APP_ROUTE_POLICY } from "@/platform/route-policy/app-route-policy";
import {
  apiRoutes,
  callCount,
  isWrapperSource,
  read,
  resolveDeclared,
} from "./helpers/route-policy";

/** The platform's verifiers: token signature, guest signature, or admin permission. */
const PLATFORM_VERIFIERS = [
  "requireActorWithStatus",
  "requireActor",
  "requireAuth",
  "adminGuard",
];

/** The platform's routes with no verifier, by design. Each needs a reason. */
const PLATFORM_PUBLIC: Readonly<Record<string, string>> = {
  "app/api/health/route.ts":
    "Liveness for monitors and the deploy smoke test; no user data.",
  "app/api/features/route.ts":
    "Which optional features exist; read by the sign-in screen.",
  "app/api/agent/capabilities/route.ts":
    "Machine-readable goal vocabulary (ADR-030 D8); provider names only, no user data.",
  "app/api/auth/sign-in/route.ts": "Establishes the session.",
  "app/api/auth/sign-up/route.ts": "Creates the account.",
  "app/api/auth/sign-out/route.ts":
    "Ends the session; revokes only the token it is given.",
  "app/api/auth/guest/route.ts": "Mints a signed guest token (ADR-050 D4).",
  "app/api/auth/forgot-password/route.ts": "Account recovery before sign-in.",
  "app/api/auth/confirm-forgot-password/route.ts": "Account recovery before sign-in.",
  "app/api/auth/verify-email/route.ts": "Email verification before first sign-in.",
  "app/api/auth/resend-verification/route.ts": "Email verification before first sign-in.",
  "app/api/auth/mfa-challenge/route.ts":
    "Second step of sign-in; the challenge session is the credential.",
  "app/api/auth/new-password-challenge/route.ts":
    "Forced password change during sign-in; the challenge session is the credential.",
  "app/api/auth/sso/[provider]/route.ts": "Starts hosted sign-in (state + PKCE).",
  "app/api/auth/sso/callback/route.ts":
    "Completes hosted sign-in; verifies state and PKCE.",
};

const ROUTES = apiRoutes();
const PUBLIC: Readonly<Record<string, string>> = {
  ...PLATFORM_PUBLIC,
  ...APP_ROUTE_POLICY.publicRoutes,
};
const VERIFIERS = resolveDeclared(PLATFORM_VERIFIERS, APP_ROUTE_POLICY.verifiers);

describe("API route caller verification (TASK-133)", () => {
  it("finds a plausible number of routes (self-test before any absence counts)", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it("accepts each declared app verifier only if it calls a platform verifier", () => {
    expect(VERIFIERS.problems).toEqual([]);
  });

  it("every route verifies its caller or is public by design", () => {
    const unverified = ROUTES.filter(
      (f) => !PUBLIC[f] && callCount(read(f), VERIFIERS.accepted) === 0
    );
    expect(unverified).toEqual([]);
  });

  it("lists no public route that does not exist, and gives each a reason", () => {
    for (const [f, reason] of Object.entries(PUBLIC)) {
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
});

describe("route verification — self-tests of the checker", () => {
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

  it("looks for wrapper definitions in source only — never in tests or Jest manual mocks", () => {
    expect(isWrapperSource("lib/route-guard.ts")).toBe(true);
    expect(isWrapperSource("lib/__mocks__/route-guard.ts")).toBe(false);
    expect(isWrapperSource("lib/__tests__/route-guard.ts")).toBe(false);
    expect(isWrapperSource("lib/route-guard.test.ts")).toBe(false);
    expect(isWrapperSource("lib/route-guard.md")).toBe(false);
  });
});
