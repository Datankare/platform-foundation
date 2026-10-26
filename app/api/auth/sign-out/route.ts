/**
 * app/api/auth/sign-out/route.ts — Sign out endpoint
 *
 * Revokes the session (audit X-17): the refresh token in the httpOnly cookie and every token of
 * the sign-in the bearer access token belongs to, then clears the cookies. A sign-out whose
 * revocation failed answers a coded 500 — the browser still stops claiming the session, but the
 * caller is not told it was revoked. The sign-out is recorded (audit A-12).
 *
 * Whose sign-out it is (review 17 M1) is only what the provider proved — never what a cookie
 * says on its own:
 *
 *   the bearer   verified (verifyToken: signature, then the provider's own answer) before its
 *                sign-out ends it: its subject is proven;
 *   the cookie   its MAC binds the user id to the refresh token it was issued with (a forged or
 *                edited cookie is no cookie), and its id is used only when it equals a proven
 *                subject. Without a proven bearer, the refresh token itself is exchanged once:
 *                a session the provider issues for the cookie's id proves it — and its fresh
 *                access token is the one signed out everywhere (GlobalSignOut). RevokeToken
 *                succeeding proves nothing about the id.
 *
 * Only a proven subject's remembered verifications are voided, and only a proven subject is the
 * `logout` record's actor: a bearer of user A with a cookie naming B signs out, voids and records
 * A only. Nothing proven: the tokens are still revoked, the record has no actor.
 */

import {
  forgetTokenVerification,
  revokeTokenVerification,
} from "@/platform/auth/token-verification";
import { NextRequest, NextResponse } from "next/server";
import {
  REFRESH_COOKIE,
  callAuthProvider,
  clearSessionCookies,
  readRefreshCookie,
} from "@/platform/auth/auth-response";
import { getAuthProvider } from "@/platform/auth/config";
import { initAuth } from "@/platform/auth/auth-init";
import { recordAuthEvent } from "@/platform/auth/auth-events";
import { auditableAccountId } from "@/platform/auth/account-identity";
import { logger } from "@/lib/logger";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

/** The subject the provider verifies `accessToken` for, or undefined (unproven, or it cannot say). */
async function verifiedSubject(accessToken: string): Promise<string | undefined> {
  try {
    initAuth();
    const payload = await getAuthProvider().verifyToken(accessToken);
    return typeof payload?.sub === "string" && payload.sub ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The cookie's user, proven by the provider issuing a session for it from the refresh token
 * (its own subject, the cookie's id): that session's access token, or undefined.
 */
async function provenByRefresh(cookie: {
  readonly userId: string;
  readonly refreshToken: string;
}): Promise<{ readonly subject: string; readonly accessToken: string } | undefined> {
  try {
    initAuth();
    const session = await getAuthProvider().refreshToken(
      cookie.refreshToken,
      cookie.userId
    );
    return session && session.accessToken && session.userId === cookie.userId
      ? { subject: session.userId, accessToken: session.accessToken }
      : undefined;
  } catch {
    return undefined;
  }
}

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;

  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  // MAC-checked (review 17 M1): a forged or edited cookie reads as none.
  const refresh = readRefreshCookie(request.cookies.get(REFRESH_COOKIE)?.value);

  let response: NextResponse = NextResponse.json({ success: true });
  // A guest token is the platform's own and expires by itself; there is nothing to revoke.
  const userToken = accessToken && !accessToken.startsWith("guest.") ? accessToken : null;

  // Who is signing out, as the provider proves it — before the sign-out ends the proof.
  let subject = userToken ? await verifiedSubject(userToken) : undefined;
  let globalToken = subject ? userToken : null;
  if (!subject && refresh) {
    const proven = await provenByRefresh(refresh);
    if (proven) {
      subject = proven.subject;
      globalToken = proven.accessToken;
    }
  }

  if (userToken || refresh) {
    const called = await callAuthProvider(
      (auth) => auth.signOut(globalToken ?? userToken ?? "", refresh?.refreshToken),
      { request, context: "Sign out failed" }
    );
    if (!called.ok) response = called.response;
  }

  if (response.ok) {
    // Signed out everywhere (GlobalSignOut): every remembered verification of the proven user's
    // tokens goes at once, on every instance (platform/auth/token-verification.ts).
    if (userToken) await forgetTokenVerification(userToken);
    if (subject) await revokeTokenVerification(subject);
    logger.info("User signed out", { proven: subject !== undefined });
    // `logout` is the account's own action — the proven subject's, never the cookie's say-so.
    const actorId = await auditableAccountId(subject);
    await recordAuthEvent(
      { action: "logout", actorId, targetId: actorId, details: {} },
      request
    );
  }

  clearSessionCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
});
