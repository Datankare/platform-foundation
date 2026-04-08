/**
 * app/api/auth/sign-out/route.ts — Sign out endpoint
 *
 * Invalidates the Cognito session and clears the session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  initAuth();

  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (accessToken) {
    const auth = getAuthProvider();
    await auth.signOut(accessToken);
  }

  logger.info("User signed out");

  const response = NextResponse.json({ success: true });

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
