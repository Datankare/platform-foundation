/**
 * app/api/auth/sso/callback/route.ts — Complete single sign-on (TASK-101)
 *
 * POST { code, state } from /auth/callback. Checks `state` against the attempt cookie set by
 * GET /api/auth/sso/[provider] (constant time), exchanges the code with the PKCE verifier, and
 * returns the session like sign-in: { success, userId, accessToken, expiresIn, email,
 * emailVerified }, the refresh token in the httpOnly refresh cookie (sessionResponse). The attempt
 * cookie is cleared on every outcome — an attempt is used once. The ID token itself is not
 * returned.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  authResultResponse,
  callAuthProvider,
  sessionResponse,
} from "@/platform/auth/auth-response";
import { isFeatureAvailable } from "@/platform/features";
import { apiError, readJsonObject } from "@/platform/errors";
import { logger } from "@/lib/logger";
import {
  SSO_COOKIE,
  SSO_COOKIE_PATH,
  decodeSsoAttempt,
  idTokenIdentity,
  sameState,
  ssoRedirectUri,
} from "@/platform/auth/sso";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { sessionTenantRefusal } from "@/platform/tenancy/identity";

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

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;
  const read = await readJsonObject(request);
  if (!read.ok) return endAttempt(read.response);
  const body = read.body as { code?: unknown; state?: unknown };

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

  const code = body.code;
  const called = await callAuthProvider(
    (auth) =>
      auth.handleSsoCallback(
        attempt.provider,
        code,
        ssoRedirectUri(request.nextUrl.origin),
        {
          codeVerifier: attempt.verifier,
        }
      ),
    { request, context: "SSO callback failed" }
  );
  if (!called.ok) return endAttempt(called.response);
  const result = called.result;

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

  // ADR-053 D2: the identity is this tenant's, or becomes it, or gets no session here.
  const refused = await sessionTenantRefusal(result, request);
  if (refused) return endAttempt(refused);

  const identity = idTokenIdentity(result.idToken);
  const response = await sessionResponse(
    {
      success: true,
      userId: result.userId,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    },
    {
      request,
      context: "SSO callback failed",
      method: "sso",
      extra: { email: identity.email, emailVerified: identity.emailVerified },
    }
  );
  return endAttempt(response);
});
