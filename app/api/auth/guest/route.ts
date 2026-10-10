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
 */

import { NextRequest, NextResponse } from "next/server";
import { mintGuestToken } from "@/platform/auth/guest-token";
import { internalError } from "@/platform/errors";
import { logger } from "@/lib/logger";

export async function POST(request?: NextRequest) {
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
}
