/**
 * app/api/auth/guest/route.ts — Start a guest session (ADR-050 D4)
 *
 * POST → { success, guestId, expiresAt } with the session cookie. The route mints a
 * platform-signed guest token (`guest.<payload>.<mac>`, platform/auth/guest-token) and keeps it
 * on the server, sealed in the guest's server-side session (ADR-057): the browser never holds
 * it. Guest tokens are the platform's, not the auth provider's, so a guest works the same under
 * any provider — including the test double an E2E harness runs (set GUEST_TOKEN_SECRET there;
 * outside production an ephemeral secret is used). Routes accept a guest only where they opt in,
 * and bound a guest's paid work with the governed allowance.
 *
 * Refused (auth.guest_refused) to a browser marked as a restricted account's, and to a request
 * presenting the session of a signed-in user whose account is banned or suspended: a restricted user
 * does not carry on as a guest (audit X-20, platform/auth/restricted-marker.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { mintGuestToken } from "@/platform/auth/guest-token";
import { logger } from "@/lib/logger";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { apiError, internalError } from "@/platform/errors";
import { getAuthProvider } from "@/platform/auth/config";
import { initAuth } from "@/platform/auth/auth-init";
import { clearLegacyCookies } from "@/platform/auth/auth-response";
import { resolveSession, startSession } from "@/platform/auth/session";
import { isInGoodStanding } from "@/platform/auth/account-status-guard";
import { resolveAccount } from "@/platform/auth/account-identity";
import { trustedVerifiedClaim } from "@/platform/auth/email-verification";
import { isMarkedRestricted, markRestricted } from "@/platform/auth/restricted-marker";

/**
 * Whether the request presents a signed-in user's session whose account may not continue as a
 * guest. No session, an ended one, or a guest's says nothing; a standing that cannot be read
 * refuses (fail closed). A presented session that fails the forgery checks is answered with that
 * refusal: another site cannot replace a user's session with a guest's.
 */
async function restrictedUser(
  request: NextRequest
): Promise<{ readonly restricted: boolean; readonly refusal?: NextResponse }> {
  const resolved = await resolveSession(request, { touch: false });
  if (resolved.error) {
    return resolved.reason === "forgery" || resolved.reason === "unavailable"
      ? { restricted: false, refusal: resolved.error }
      : { restricted: false };
  }
  if (resolved.session.kind !== "user") return { restricted: false };
  try {
    initAuth();
    const user = await getAuthProvider().verifyToken(resolved.session.identityToken);
    if (!user) return { restricted: false };
    // The account the identity is bound to, not its subject (TASK-174).
    const account = await resolveAccount(user.sub);
    if (account.kind === "conflict") return { restricted: true };
    // With the token's profile (TASK-185): an account first provisioned by this check gets its
    // address, stored verified only from a trusted source — never created without one.
    return {
      restricted: !(await isInGoodStanding(account.accountId, {
        email: user.email,
        emailVerified: trustedVerifiedClaim(user),
      })),
    };
  } catch {
    return { restricted: true };
  }
}

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_GUEST);
  if (limited) return limited;

  if (isMarkedRestricted(request)) {
    logger.info("Guest session refused: the browser belongs to a restricted account");
    return apiError("auth.guest_refused", { request });
  }
  const standing = await restrictedUser(request);
  if (standing.refusal) return standing.refusal;
  if (standing.restricted) {
    logger.info("Guest session refused: the caller's account is restricted");
    const refused = apiError("auth.guest_refused", { request });
    markRestricted(refused);
    return refused;
  }

  let minted: Awaited<ReturnType<typeof mintGuestToken>>;
  try {
    minted = await mintGuestToken();
  } catch (err) {
    // Production without GUEST_TOKEN_SECRET (the contract refuses that boot for a real auth
    // provider): a logged 500 with a request id, never the reason.
    return internalError(err, { request, context: "Guest session failed" });
  }

  const { guestId, token, expiresAt } = minted;
  logger.info("Guest session created", { guestId });
  // The guest token stays on the server, sealed in the guest's session (ADR-057): the browser
  // receives the session cookie and the guest's id, never the token.
  const response = NextResponse.json({ success: true, guestId, expiresAt });
  response.headers.set("Cache-Control", "no-store");
  try {
    await startSession(request, response, {
      kind: "guest",
      subject: guestId,
      method: "guest",
      tokens: { kind: "guest", token, expiresAt },
    });
  } catch (err) {
    return internalError(err, { request, context: "Guest session failed" });
  }
  clearLegacyCookies(response);
  return response;
});
