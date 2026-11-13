/**
 * proxy.ts — Next.js proxy for route protection (Next 16 convention)
 *
 * GenAI Principles:
 *   P3 — Protected routes screened before access
 *   P9 — Auth failures logged with route context
 *
 * What it checks, and what it does not (audit A-16; ADR-057): only that a request PRESENTS a
 * credential — the session cookie (its name; the value is never read here) or, for a machine
 * client, an Authorization header. It verifies nothing: anyone can send a cookie of that name.
 * Every API route verifies its caller itself (requireAuth, requireActor, requireAdmin — enforced
 * by __tests__/api-route-auth.test.ts), and a page holds no data of its own: what it shows comes
 * from those verified API calls.
 *
 * It also turns away a state-changing API request that says it comes from another origin
 * (ADR-057 D4), before any route runs: the routes with no session yet (sign-in, sign-up, a
 * guest's start) have no session token to check, so this is their forgery defence; a route with
 * a session checks the origin again, strictly, with the session's token
 * (platform/auth/session.ts). A request that names no origin (a machine client) passes here.
 *
 * Routes:
 *   /auth, /auth/callback — public (sign-in, SSO return)
 *   /api/auth/*, /api/health*, /api/features — passed through (each route decides)
 *   /api/*       — refused 401 without a session cookie or an Authorization header; otherwise
 *                  passed to the route, which verifies the session (a user route) or the machine
 *                  credential (the jobs tick; an app's agent routes) and the caller's permissions
 *   other pages  — redirected to /auth without the session cookie (a convenience, not a
 *                  control: /admin's data is behind requireAdmin on the API)
 *
 * The browser holds no token: the session cookie is HttpOnly, and the identity provider's tokens
 * stay on the server (platform/auth/session-vault.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/platform/errors";
import { isStateChanging, requestOriginVerdict } from "@/platform/auth/request-origin";
import { sessionCookieName } from "@/platform/auth/session-cookie";
import {
  CSP_HEADER,
  NONCE_HEADER,
  contentSecurityPolicy,
  newNonce,
} from "@/platform/security/csp";

/**
 * Every response carries a Content Security Policy with its own nonce (audit G-10); the request
 * carries it on to Next.js, which puts the nonce on the scripts it renders.
 */
function withPolicy(request: NextRequest, respond: (headers: Headers) => NextResponse) {
  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce, {
    development: process.env.NODE_ENV === "development",
  });
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  headers.set(CSP_HEADER, policy);
  const response = respond(headers);
  response.headers.set(CSP_HEADER, policy);
  return response;
}

const pass = (headers: Headers) => NextResponse.next({ request: { headers } });

/** Routes that don't require authentication */
const PUBLIC_ROUTES = new Set(["/auth", "/auth/callback"]);

/** Route prefixes that are always public */
const PUBLIC_PREFIXES = [
  "/api/auth/",
  "/api/health",
  "/api/features",
  "/_next/",
  "/favicon.ico",
];

/** Check if a route is public */
function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest) {
  return withPolicy(request, (headers) => route(request, headers));
}

/** Whether the request presents a session cookie (its presence only — it is verified by the routes). */
function presentsSession(request: NextRequest): boolean {
  return Boolean(request.cookies.get(sessionCookieName())?.value);
}

function route(request: NextRequest, headers: Headers): NextResponse {
  const { pathname } = request.nextUrl;

  // ADR-057 D4: a state-changing API request from another origin goes no further.
  if (
    pathname.startsWith("/api/") &&
    isStateChanging(request) &&
    requestOriginVerdict(request) === "cross"
  ) {
    return apiError("auth.csrf_failed", { request });
  }

  // Public routes — pass through
  if (isPublicRoute(pathname)) {
    return pass(headers);
  }

  // API routes — a credential must be presented (verified in the route handlers)
  if (pathname.startsWith("/api/")) {
    // A machine's credential, whatever its scheme (a bearer: the jobs tick's secret, an agent's
    // delegation token; Basic: an agent's client credential at its token endpoint, RFC 6749
    // §2.3.1). A browser sends no Authorization header of its own; presence only, as the cookie.
    const presentsMachineCredential = Boolean(
      request.headers.get("authorization")?.trim()
    );
    if (!presentsSession(request) && !presentsMachineCredential) {
      // ADR-051: coded like every other API error (auth.required, 401).
      return apiError("auth.required", { request });
    }
    // Credentials present: the route handler validates them. An API call is never redirected
    // to the sign-in page — a machine client (an agent, the jobs tick) has no session cookie and
    // would otherwise receive a 307 to /auth instead of the API's answer.
    return pass(headers);
  }

  // Page routes — without a session cookie, to sign-in. The session itself is verified when the
  // page makes its API calls.
  if (!presentsSession(request)) {
    const authUrl = new URL("/auth", request.url);
    authUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(authUrl);
  }

  return pass(headers);
}

export const config = {
  matcher: [
    /*
     * Match all routes except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public folder
     */
    "/((?!_next/static|_next/image|favicon.ico|public/).*)",
  ],
};
