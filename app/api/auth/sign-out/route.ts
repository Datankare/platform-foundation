/**
 * app/api/auth/sign-out/route.ts — Sign out (ADR-057 D6; audit X-17, A-12)
 *
 * POST, no body. Ends the session the cookie names — in its record first, so the id replayed
 * afterwards finds a revoked row, then its refresh token at the identity provider — and clears
 * the cookie. The user's other sessions are untouched (POST /api/auth/sign-out-everywhere ends
 * them all). The sign-out is recorded (`logout`), for the session's own subject: the record is
 * the proof of whose session it was, nothing the request says.
 *
 * A request without a live session still leaves with its cookies cleared and `success` (there is
 * nothing to end). A state-changing request: it must come from this origin with the session's
 * token — another site cannot sign a user out.
 *
 * A browser signed in before ADR-057 may still hold the legacy refresh cookie: its token is
 * revoked too, and the cookie cleared.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  LEGACY_REFRESH_COOKIE,
  clearSessionCookies,
  readLegacyRefreshCookie,
} from "@/platform/auth/auth-response";
import { getAuthProvider } from "@/platform/auth/config";
import { initAuth } from "@/platform/auth/auth-init";
import { recordAuthEvent } from "@/platform/auth/auth-events";
import { auditableAccountId } from "@/platform/auth/account-identity";
import { endSession, resolveSession } from "@/platform/auth/session";
import { internalError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;

  const resolved = await resolveSession(request, { touch: false });
  // Forged, or the store cannot answer: nothing is ended and nothing cleared.
  if (resolved.error && resolved.reason !== "none" && resolved.reason !== "ended") {
    return resolved.error;
  }

  let response: NextResponse = NextResponse.json({ success: true });
  if (resolved.session) {
    const session = resolved.session;
    try {
      await endSession(session, "sign_out");
    } catch (err) {
      // Not ended: the caller is told so, and keeps nothing that claims a session.
      response = internalError(err, { request, context: "Sign out failed" });
    }
    if (response.ok) {
      logger.info("Session signed out", { kind: session.kind });
      if (session.kind === "user") {
        const actorId = await auditableAccountId(session.subject);
        await recordAuthEvent(
          { action: "logout", actorId, targetId: actorId, details: {} },
          request
        );
      }
    }
  }

  // A legacy browser's refresh token (MAC-checked: a forged cookie reads as none).
  const legacy = readLegacyRefreshCookie(
    request.cookies.get(LEGACY_REFRESH_COOKIE)?.value
  );
  if (legacy) {
    try {
      initAuth();
      await getAuthProvider().signOut("", legacy.refreshToken);
    } catch {
      // It expires on its own; the cookie is cleared below.
    }
  }

  clearSessionCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
});
