/**
 * app/api/auth/refresh/route.ts — Renew the access token (audit A-14, X-17)
 *
 * POST, no body. The refresh token is read from the httpOnly refresh cookie — script never sees
 * it, and a cookie whose MAC fails (review 17 M1: forged, edited, or unsigned) is refused like a
 * missing one — and exchanged for a new access token for the same user; the answer is
 * { success, userId, accessToken, expiresIn }, with the session indicator renewed. A missing,
 * malformed, expired or revoked refresh token answers auth.token_invalid and clears the cookies:
 * the browser signs in again. SameSite=Strict keeps another site from triggering it; it returns
 * nothing to a cross-site reader either way (the token is in the response body, which a
 * cross-origin page cannot read).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  REFRESH_COOKIE,
  REFRESH_COOKIE_MAX_AGE,
  callAuthProvider,
  clearSessionCookies,
  readRefreshCookie,
  setSessionIndicator,
} from "@/platform/auth/auth-response";
import { apiError } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { sessionTenantRefusal } from "@/platform/tenancy/identity";

function refused(request: NextRequest): NextResponse {
  const response = apiError("auth.token_invalid", { request });
  clearSessionCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;

  const cookie = readRefreshCookie(request.cookies.get(REFRESH_COOKIE)?.value);
  if (!cookie) return refused(request);

  const called = await callAuthProvider(
    (auth) => auth.refreshToken(cookie.refreshToken, cookie.userId),
    { request, context: "Session refresh failed" }
  );
  if (!called.ok) return called.response;
  const session = called.result;
  // The renewed session is the cookie's user's, or it is not used.
  if (!session || !session.accessToken || session.userId !== cookie.userId) {
    return refused(request);
  }
  const expiresIn = Math.max(0, session.expiresAt - Math.floor(Date.now() / 1000));
  const result = {
    success: true,
    userId: session.userId,
    accessToken: session.accessToken,
    expiresIn,
  };
  // ADR-053 D2: the identity is still this tenant's, or gets no session here.
  const tenantRefusal = await sessionTenantRefusal(result, request);
  if (tenantRefusal) {
    clearSessionCookies(tenantRefusal);
    return tenantRefusal;
  }

  const response = NextResponse.json(result);
  response.headers.set("Cache-Control", "no-store");
  setSessionIndicator(response, REFRESH_COOKIE_MAX_AGE);
  return response;
});
