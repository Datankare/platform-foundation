/**
 * app/api/auth/sign-out/route.ts — Sign out endpoint
 *
 * Revokes the session (audit X-17): the refresh token in the httpOnly cookie and every token of
 * the sign-in the bearer access token belongs to, then clears the cookies. A sign-out whose
 * revocation failed answers a coded 500 — the browser still stops claiming the session, but the
 * caller is not told it was revoked. The sign-out is recorded (audit A-12).
 */

import {
  forgetTokenVerification,
  revokeTokenVerification,
  tokenSubject,
} from "@/platform/auth/token-verification";
import { NextRequest, NextResponse } from "next/server";
import {
  REFRESH_COOKIE,
  callAuthProvider,
  clearSessionCookies,
  readRefreshCookie,
} from "@/platform/auth/auth-response";
import { auditableUserId, recordAuthEvent } from "@/platform/auth/auth-events";
import { logger } from "@/lib/logger";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;

  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const refresh = readRefreshCookie(request.cookies.get(REFRESH_COOKIE)?.value);

  let response: NextResponse = NextResponse.json({ success: true });
  // A guest token is the platform's own and expires by itself; there is nothing to revoke.
  const userToken = accessToken && !accessToken.startsWith("guest.") ? accessToken : null;
  if (userToken || refresh) {
    const called = await callAuthProvider(
      (auth) => auth.signOut(userToken ?? "", refresh?.refreshToken),
      { request, context: "Sign out failed" }
    );
    if (!called.ok) response = called.response;
  }

  if (response.ok) {
    // Signed out everywhere (GlobalSignOut): every remembered verification of the user's tokens
    // goes at once, on every instance (platform/auth/token-verification.ts).
    const subject = refresh?.userId ?? (userToken ? tokenSubject(userToken) : undefined);
    if (userToken) await forgetTokenVerification(userToken);
    if (subject) await revokeTokenVerification(subject);
    logger.info("User signed out");
    // `logout` is recorded as the account's own action; who it was is known from the cookie.
    const actorId = auditableUserId(refresh?.userId);
    await recordAuthEvent(
      { action: "logout", actorId, targetId: actorId, details: {} },
      request
    );
  }

  clearSessionCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
});
