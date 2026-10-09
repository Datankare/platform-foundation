/**
 * app/api/auth/sso/[provider]/route.ts — Start single sign-on (TASK-101)
 *
 * GET /api/auth/sso/google — a browser navigation from the sign-in screen. Creates the attempt
 * (state + PKCE verifier) in an httpOnly cookie and redirects to the identity provider's hosted
 * sign-in. The provider returns the browser to /auth/callback, which completes the exchange
 * through POST /api/auth/sso/callback.
 *
 * This is a navigation, not a fetch, so a failure redirects to /auth?error=<code> (the sign-in
 * screen renders the catalog message) rather than showing a JSON body.
 */

import { NextRequest, NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { isFeatureAvailable } from "@/platform/features";
import type { ErrorCode } from "@/platform/errors";
import { logger } from "@/lib/logger";
import {
  SSO_COOKIE,
  SSO_COOKIE_MAX_AGE_SECONDS,
  SSO_COOKIE_PATH,
  encodeSsoAttempt,
  isSsoProvider,
  pkceChallenge,
  randomToken,
  ssoRedirectUri,
} from "@/platform/auth/sso";

function backToSignIn(request: NextRequest, code: ErrorCode): NextResponse {
  const url = new URL("/auth", request.nextUrl.origin);
  url.searchParams.set("error", code);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  const { provider } = await context.params;

  // ADR-050 D3: only configured providers are offered — and only they can be started.
  if (!isSsoProvider(provider) || !isFeatureAvailable(`sso_${provider}`)) {
    return backToSignIn(request, "feature.not_configured");
  }

  initAuth();
  const state = randomToken();
  const verifier = randomToken();
  const result = await getAuthProvider().initiateSso(
    provider,
    ssoRedirectUri(request.nextUrl.origin),
    { state, codeChallenge: await pkceChallenge(verifier) }
  );

  if (!result.success || !result.redirectUrl) {
    logger.warn("SSO initiation failed", { provider, error: result.error });
    return backToSignIn(request, result.errorCode ?? "auth.sso_failed");
  }

  const response = NextResponse.redirect(result.redirectUrl, 302);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(SSO_COOKIE, encodeSsoAttempt({ provider, state, verifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: SSO_COOKIE_PATH,
    maxAge: SSO_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
