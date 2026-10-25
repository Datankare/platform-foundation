/**
 * proxy.ts — Next.js proxy for route protection (Next 16 convention)
 *
 * GenAI Principles:
 *   P3 — Protected routes screened before access
 *   P9 — Auth failures logged with route context
 *
 * What it checks, and what it does not (audit A-16): only that a request PRESENTS a session —
 * the pf_has_session indicator cookie or an Authorization header. It verifies nothing; the
 * indicator is not a credential and anyone can set it. Every API route verifies its caller
 * itself (requireAuth, requireActor, requireAdmin — enforced by __tests__/api-route-auth.test.ts),
 * and a page holds no data of its own: what it shows comes from those verified API calls.
 *
 * Routes:
 *   /auth, /auth/callback — public (sign-in, SSO return)
 *   /api/auth/*, /api/health*, /api/features — passed through (each route decides)
 *   /api/*       — refused 401 without a session indicator or a bearer; otherwise passed to the
 *                  route, which verifies the token and the caller's permissions
 *   other pages  — redirected to /auth without the session indicator (a convenience, not a
 *                  control: /admin's data is behind requireAdmin on the API)
 *
 * The browser keeps the short-lived access token in its storage; the refresh token is an
 * httpOnly cookie sent only to /api/auth (platform/auth/auth-response.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/platform/errors";
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

function route(request: NextRequest, headers: Headers): NextResponse {
  const { pathname } = request.nextUrl;

  // Public routes — pass through
  if (isPublicRoute(pathname)) {
    return pass(headers);
  }

  // API routes — require Authorization header (validated in route handlers)
  if (pathname.startsWith("/api/")) {
    const authHeader = request.headers.get("authorization");
    const hasCookie = request.cookies.get("pf_has_session")?.value === "true";
    const hasBearer = authHeader && authHeader.startsWith("Bearer ");
    if (!hasCookie && !hasBearer) {
      // ADR-051: coded like every other API error (auth.required, 401).
      return apiError("auth.required", { request });
    }
    // Credentials present: the route handler validates them. An API call is never redirected
    // to the sign-in page — a bearer-only client (an agent, the deployed smoke test, k6) has no
    // session cookie and would otherwise receive a 307 to /auth instead of the API's answer.
    return pass(headers);
  }

  // Page routes — check for session cookie (lightweight check)
  // The real JWT validation happens when the page makes API calls.
  // If no session indicator, redirect to /auth.
  const hasSession = request.cookies.get("pf_has_session")?.value === "true";

  if (!hasSession) {
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
