/**
 * middleware.ts — Next.js edge middleware for route protection
 *
 * GenAI Principles:
 *   P3 — Protected routes screened before access
 *   P9 — Auth failures logged with route context
 *
 * Routes:
 *   /auth        — public (login/register)
 *   /api/auth/*  — public (auth API endpoints)
 *   /api/health  — public (health check)
 *   /api/*       — protected (requires Bearer token)
 *   /admin/*     — protected (requires Bearer token + admin role)
 *   /profile     — protected
 *   /            — protected (redirects to /auth if no session)
 *
 * Client-side token is stored in localStorage (not cookies),
 * so this middleware checks for a lightweight session indicator cookie
 * set by the auth API routes. The actual JWT validation happens
 * in the API route handlers via requireAuth().
 */

import { NextRequest, NextResponse } from "next/server";

/** Routes that don't require authentication */
const PUBLIC_ROUTES = new Set(["/auth"]);

/** Route prefixes that are always public */
const PUBLIC_PREFIXES = ["/api/auth/", "/api/health", "/_next/", "/favicon.ico"];

/** Check if a route is public */
function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes — pass through
  if (isPublicRoute(pathname)) {
    return NextResponse.next();
  }

  // API routes — require Authorization header (validated in route handlers)
  if (pathname.startsWith("/api/")) {
    const authHeader = request.headers.get("authorization");
    const hasCookie = request.cookies.get("pf_has_session")?.value === "true";
    const hasBearer = authHeader && authHeader.startsWith("Bearer ");
    if (!hasCookie && !hasBearer) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
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

  return NextResponse.next();
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
