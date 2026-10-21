/**
 * __tests__/api-route-auth.test.ts — Every API route verifies its caller
 *
 * The proxy (proxy.ts) only checks that credentials are PRESENT on /api/* and leaves
 * verification to the route handler. A handler that forgets to verify is therefore open to any
 * request carrying "Authorization: Bearer <anything>" — which is how /api/stream ran
 * unauthenticated until 2026-10 (TASK-133). This test makes the rule mechanical: each route
 * file must call a verifier, or be listed below as public by design, with the reason.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "app", "api");

/** Calls that verify the caller (token signature, guest signature, or admin permission). */
const VERIFIERS = [
  /\brequireActorWithStatus\s*\(/,
  /\brequireActor\s*\(/,
  /\brequireAuth\s*\(/,
  /\badminGuard\s*\(/,
];

/** Routes with no verifier, by design. Each needs a reason; a stale entry fails the test. */
const PUBLIC_BY_DESIGN: Readonly<Record<string, string>> = {
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

describe("API route caller verification (TASK-133)", () => {
  it("finds a plausible number of routes (self-test before any absence counts)", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it("every route verifies its caller or is public by design", () => {
    const unverified = ROUTES.filter((f) => {
      if (PUBLIC_BY_DESIGN[f]) return false;
      const src = readFileSync(join(ROOT, f), "utf-8");
      return !VERIFIERS.some((v) => v.test(src));
    });
    expect(unverified).toEqual([]);
  });

  it("lists no public route that no longer exists", () => {
    const missing = Object.keys(PUBLIC_BY_DESIGN).filter((f) => !ROUTES.includes(f));
    expect(missing).toEqual([]);
  });

  it("gives every public route a reason", () => {
    for (const [f, reason] of Object.entries(PUBLIC_BY_DESIGN)) {
      expect({ f, hasReason: reason.trim().length > 10 }).toEqual({ f, hasReason: true });
    }
  });

  it("the self-test catches a route with no verifier", () => {
    const src = "export async function POST() { return new Response('open'); }";
    expect(VERIFIERS.some((v) => v.test(src))).toBe(false);
  });
});
