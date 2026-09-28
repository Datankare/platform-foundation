/**
 * app/api/auth/sso/callback/route.ts — Complete single sign-on (TASK-101)
 *
 * POST { code, state } from /auth/callback. Checks `state` against the attempt cookie set by
 * GET /api/auth/sso/[provider] (constant time), exchanges the code with the PKCE verifier, and
 * returns the session like sign-in: { success, userId, accessToken, refreshToken, expiresIn,
 * email, emailVerified }. The attempt cookie is cleared on every outcome — an attempt is used
 * once. The ID token itself is not returned.
 */

import { NextRequest, NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { authResultResponse } from "@/platform/auth/auth-response";
import { isFeatureAvailable } from "@/platform/features";
import { apiError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import {
  SSO_COOKIE,
  SSO_COOKIE_PATH,
  decodeSsoAttempt,
  idTokenIdentity,
  sameState,
  ssoRedirectUri,
} from "@/platform/auth/sso";

function endAttempt(response: NextResponse): NextResponse {
  response.cookies.set(SSO_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: SSO_COOKIE_PATH,
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  let body: { code?: unknown; state?: unknown };
  try {
    body = await request.json();
  } catch {
    return endAttempt(apiError("request.invalid_json", { request }));
  }

  if (typeof body.code !== "string" || !body.code || typeof body.state !== "string") {
    return endAttempt(
      apiError("request.missing_fields", {
        params: { fields: ["code", "state"] },
        request,
      })
    );
  }

  const attempt = decodeSsoAttempt(request.cookies.get(SSO_COOKIE)?.value);
  if (!attempt || !sameState(attempt.state, body.state)) {
    // No attempt from this browser, an expired one, or a state that isn't ours: never exchange.
    logger.warn("SSO callback rejected: state mismatch or no attempt", {
      hasAttempt: attempt !== null,
    });
    return endAttempt(apiError("auth.sso_failed", { request }));
  }

  if (!isFeatureAvailable(`sso_${attempt.provider}`)) {
    return endAttempt(
      apiError("feature.not_configured", {
        params: { feature: `sso_${attempt.provider}` },
        request,
      })
    );
  }

  initAuth();
  const result = await getAuthProvider().handleSsoCallback(
    attempt.provider,
    body.code,
    ssoRedirectUri(request.nextUrl.origin),
    { codeVerifier: attempt.verifier }
  );

  if (!result.success || !result.accessToken) {
    logger.warn("SSO callback failed", {
      provider: attempt.provider,
      error: result.error,
    });
    return endAttempt(
      authResultResponse(
        { ...result, success: false, errorCode: result.errorCode ?? "auth.sso_failed" },
        { request, context: "SSO callback failed" }
      )
    );
  }

  const identity = idTokenIdentity(result.idToken);
  const response = authResultResponse(
    {
      success: true,
      userId: result.userId,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      email: identity.email,
      emailVerified: identity.emailVerified,
    },
    { request }
  );

  // Session indicator for the page proxy, as sign-in sets it.
  response.cookies.set("pf_has_session", "true", {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: result.expiresIn ?? 3600,
  });
  return endAttempt(response);
}
