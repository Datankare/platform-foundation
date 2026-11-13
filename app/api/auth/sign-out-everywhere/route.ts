/**
 * app/api/auth/sign-out-everywhere/route.ts — Sign out on every device (ADR-057 D6)
 *
 * POST, no body. Ends every session of the signed-in user in this tenant — this one included —
 * in their records, revokes each one's refresh token, and asks the identity provider to end
 * every token it issued the user (an administrative call; tokens this platform never held
 * included). Answers `{ success, sessionsEnded, providerSignedOut }`: `providerSignedOut` false
 * means the platform's sessions are ended but the provider could not be asked (its
 * administrative key lacks the action — operator readiness, "sessions", says so). Recorded as
 * `logout` with `everywhere: true`.
 *
 * Users only (a guest has one session; sign-out ends it). A state-changing request: this origin,
 * with the session's token.
 */

import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookies } from "@/platform/auth/auth-response";
import { recordAuthEvent } from "@/platform/auth/auth-events";
import { auditableAccountId } from "@/platform/auth/account-identity";
import { requireAuth } from "@/platform/auth/middleware";
import { revokeSubjectSessions } from "@/platform/auth/session-revocation";
import { revokeTokenVerification } from "@/platform/auth/token-verification";
import { internalError } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;

  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  let outcome: Awaited<ReturnType<typeof revokeSubjectSessions>>;
  try {
    outcome = await revokeSubjectSessions(auth.user.sub, "sign_out_everywhere", {
      everywhere: true,
    });
  } catch (err) {
    return internalError(err, { request, context: "Sign out everywhere failed" });
  }
  // Nothing remembered about the user's tokens outlives the sign-out.
  await revokeTokenVerification(auth.user.sub);
  const actorId = await auditableAccountId(auth.user.sub);
  await recordAuthEvent(
    {
      action: "logout",
      actorId,
      targetId: actorId,
      details: { everywhere: true, sessions: outcome.ended },
    },
    request
  );
  const response = NextResponse.json({
    success: true,
    sessionsEnded: outcome.ended,
    providerSignedOut: outcome.providerSignedOut === true,
  });
  clearSessionCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
});
