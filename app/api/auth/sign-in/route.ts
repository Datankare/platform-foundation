/**
 * app/api/auth/sign-in/route.ts — Sign in endpoint
 *
 * POST { email, password } → AuthResult
 * Calls AuthProvider.signIn() on the server side.
 */

import { NextRequest, NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  initAuth();

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  if (!body.email || !body.password) {
    return NextResponse.json(
      { success: false, error: "Email and password are required" },
      { status: 400 }
    );
  }

  const auth = getAuthProvider();
  const result = await auth.signIn(body.email, body.password);

  if (!result.success) {
    logger.warn("Sign in failed", { email: body.email, error: result.error });
  }

  const response = NextResponse.json(result);

  // Set session indicator cookie for middleware route protection
  if (result.success && result.accessToken) {
    response.cookies.set("pf_has_session", "true", {
      httpOnly: false, // Readable by client for UX, but not sensitive
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: result.expiresIn ?? 3600,
    });
  }

  return response;
}
