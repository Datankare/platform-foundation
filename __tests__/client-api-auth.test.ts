/**
 * __tests__/client-api-auth.test.ts — screens call the API as the signed-in user
 *
 * Every authenticated route reads the caller from `Authorization: Bearer` (platform/auth/
 * middleware.ts). A screen that called `fetch("/api/…")` sent no token and was refused with 401 —
 * the whole admin console, the review dashboard, appeals and the main screen did, until
 * apiFetch (platform/auth/api-fetch.ts). This keeps it so: browser code reaches the platform's
 * API through apiFetch, except the listed calls that run before there is a session or set the
 * header themselves.
 */

import { productionSources, read } from "./helpers/route-policy";
import { APP_ROUTE_POLICY } from "@/platform/route-policy/app-route-policy";

/** The platform's direct fetch calls, and why. A new one is a reviewed change. */
const PLATFORM_DIRECT: Readonly<Record<string, string>> = {
  "components/auth/useSsoProviders.ts": "/api/features — public, read before sign-in",
  "components/auth/AuthPage.tsx": "/api/auth/guest — creates the session",
  "app/auth/callback/SsoCallbackClient.tsx":
    "/api/auth/sso/callback — creates the session",
  "platform/auth/context.tsx":
    "/api/auth/refresh (the httpOnly refresh cookie is the credential) and /api/auth/sign-out (sets the Authorization header itself)",
  "hooks/useRealtimeStream.ts": "/api/stream — sets the Authorization header itself",
};

/** With the app's own, declared in app-route-policy.ts (directFetch). */
const DIRECT: Readonly<Record<string, string>> = {
  ...PLATFORM_DIRECT,
  ...(APP_ROUTE_POLICY.directFetch ?? {}),
};

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Browser code: anything outside the API routes, the server-only platform and lib. */
const CLIENT = productionSources().filter(
  (f) =>
    /\.[jt]sx?$/.test(f) &&
    !f.startsWith("app/api/") &&
    (f.startsWith("components/") ||
      f.startsWith("hooks/") ||
      f.startsWith("app/") ||
      /^platform\/.*\.tsx$/.test(f))
);

/** A bare fetch( call — not apiFetch(, not .fetch( on another object. */
const BARE_FETCH = /(?<![\w.])fetch\s*\(/;

describe("screens call the API as the signed-in user", () => {
  it("finds the browser sources (self-test)", () => {
    expect(CLIENT.length).toBeGreaterThan(20);
    expect(CLIENT).toContain("app/admin/page.tsx");
  });

  it("recognises a bare fetch and nothing else (self-test)", () => {
    expect(BARE_FETCH.test('await fetch("/api/x")')).toBe(true);
    expect(BARE_FETCH.test("const r = fetch(url)")).toBe(true);
    expect(BARE_FETCH.test('await apiFetch("/api/x")')).toBe(false);
    expect(BARE_FETCH.test("window.fetch(x)")).toBe(false);
    expect(BARE_FETCH.test("prefetch(x)")).toBe(false);
  });

  it("uses apiFetch, except the listed calls", () => {
    const offenders = CLIENT.filter(
      (f) => !(f in DIRECT) && BARE_FETCH.test(strip(read(f)))
    );
    expect(offenders).toEqual([]);
  });

  it("lists no file that no longer calls fetch directly", () => {
    const stale = Object.keys(DIRECT).filter((f) => {
      try {
        return !BARE_FETCH.test(strip(read(f)));
      } catch {
        return true; // listed, but no such file
      }
    });
    expect(stale).toEqual([]);
  });
});
