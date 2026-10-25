/**
 * app/api/auth/guest/route.ts — Start a guest session (ADR-050 D4)
 *
 * POST → { success, guestId, token, expiresAt } — a platform-signed guest token
 * (`guest.<payload>.<mac>`, platform/auth/guest-token). Guest tokens are the platform's, not the
 * auth provider's: the route mints them itself, so a guest works the same under any provider —
 * including the test double an E2E harness runs (set GUEST_TOKEN_SECRET there; outside
 * production an ephemeral secret is used). Routes accept a guest only where they opt in, and
 * bound a guest's paid work with the governed allowance.
 *
 * Sets the page proxy's session indicator for the token's lifetime.
 *
 * Refused (auth.guest_refused) to a browser marked as a restricted account's, and to a request
 * carrying the token of a signed-in user whose account is banned or suspended: a restricted user
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
import { GUEST_TOKEN_PREFIX } from "@/platform/auth/guest-token";
import { isInGoodStanding } from "@/platform/auth/account-status-guard";
import { isMarkedRestricted, markRestricted } from "@/platform/auth/restricted-marker";

/**
 * Whether the request carries a signed-in user's token whose account may not continue as a
 * guest. A token that does not verify is not a user's, and says nothing; a standing that cannot
 * be read refuses (fail closed).
 */
async function restrictedUser(request: NextRequest): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (!token || token.startsWith(GUEST_TOKEN_PREFIX)) return false;
  try {
    initAuth();
    const user = await getAuthProvider().verifyToken(token);
    if (!user) return false;
    return !(await isInGoodStanding(user.sub));
  } catch {
    return true;
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
  if (await restrictedUser(request)) {
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
  const response = NextResponse.json({ success: true, guestId, token, expiresAt });
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set("pf_has_session", "true", {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
  });
  return response;
});
