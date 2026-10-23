/**
 * app/api/auth/sign-out/route.ts — Sign out endpoint
 *
 * Invalidates the Cognito session and clears the session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { callAuthProvider } from "@/platform/auth/auth-response";
import { logger } from "@/lib/logger";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

export async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;

  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let response: NextResponse = NextResponse.json({ success: true });
  if (accessToken) {
    const called = await callAuthProvider((auth) => auth.signOut(accessToken), {
      request,
      context: "Sign out failed",
    });
    // The revocation failed (a coded 500), but this browser still stops claiming a session.
    if (!called.ok) response = called.response;
  }

  if (response.ok) logger.info("User signed out");

  // Clear session cookie
  response.cookies.set("pf_has_session", "", {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}
