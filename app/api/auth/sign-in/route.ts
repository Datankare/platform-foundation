/**
 * app/api/auth/sign-in/route.ts — Sign in endpoint
 *
 * POST { email, password } → AuthResult
 * Calls AuthProvider.signIn() on the server side.
 */

import { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { readJsonObject, requireTextFields } from "@/platform/errors";
import { authResultResponse, callAuthProvider } from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { sessionTenantRefusal } from "@/platform/tenancy/identity";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_LOGIN);
  if (limited) return limited;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  // Typed as text: requireTextFields below refuses anything else before it is used.
  const body = read.body as { email: string; password: string };

  const invalid = requireTextFields(body, ["email", "password"], request);
  if (invalid) return invalid;

  const called = await callAuthProvider(
    (auth) => auth.signIn(body.email, body.password),
    {
      request,
      context: "Sign in failed",
    }
  );
  if (!called.ok) return called.response;
  const result = called.result;

  if (!result.success) {
    logger.warn("Sign in failed", { route: "api/auth/sign-in", error: result.error });
  }

  // ADR-053 D2: the identity is this tenant's, or becomes it, or gets no session here.
  const refused = await sessionTenantRefusal(result, request);
  if (refused) return refused;

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
});
