/**
 * app/api/auth/sign-in/route.ts — Sign in endpoint
 *
 * POST { email, password } → AuthResult
 * Calls AuthProvider.signIn() on the server side.
 */

import { NextRequest } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { logger } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import { authResultResponse } from "@/platform/auth/auth-response";

export async function POST(request: NextRequest) {
  initAuth();

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return apiError("request.invalid_json", { request });
  }

  if (!body.email || !body.password) {
    return apiError("request.missing_fields", {
      params: { fields: ["email", "password"] },
      request,
    });
  }

  const auth = getAuthProvider();
  const result = await auth.signIn(body.email, body.password);

  if (!result.success) {
    logger.warn("Sign in failed", { email: body.email, error: result.error });
  }

  const response = authResultResponse(result, { request, context: "Sign in failed" });

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
