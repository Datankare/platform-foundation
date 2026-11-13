/**
 * app/api/auth/session/route.ts — the browser's view of its session (ADR-057 D1, D4, D5)
 *
 * GET   Who the session cookie signs in, for this origin's script — the only way a page learns
 *       it, since it can read neither the cookie nor any token:
 *         { authenticated: true, user: { userId, email, emailVerified, isGuest }, csrfToken,
 *           audience, idleExpiresAt, absoluteExpiresAt, idleWarningSeconds }
 *       or { authenticated: false } (no session, or one that has ended — its cookie is cleared).
 *       `csrfToken` is the session's forgery token, sent back in `x-csrf-token` on every
 *       state-changing request; it is not a credential (it does nothing without the HttpOnly
 *       cookie). Reading the status does not count as use of the session: the idle limit keeps
 *       running, so a page that polls it to warn before an idle sign-out does not keep itself
 *       signed in. Limited per session (AUTH_SESSION_STATUS), or per address without one.
 * POST  "Stay signed in": counts as use (the idle limit starts again) and answers as GET — or,
 *       without a live session, the coded refusal (401). A state-changing request: this origin,
 *       with the session's token.
 *
 * Never cached. No token of the identity provider is in either answer.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireActor } from "@/platform/auth/middleware";
import {
  clearSessionCookie,
  hashSessionId,
  keepAlive,
  presentedSessionId,
  type LiveSession,
} from "@/platform/auth/session";
import { STAFF_IDLE_WARNING_SECONDS } from "@/platform/auth/session-lifetimes";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function signedOut(clear: boolean): NextResponse {
  const response = NextResponse.json({ authenticated: false });
  if (clear) clearSessionCookie(response);
  return noStore(response);
}

async function describe(request: NextRequest, touch: boolean): Promise<NextResponse> {
  // The session's user or guest, verified as every route verifies it. Reading does not count as
  // use: "stay signed in" counts once, below.
  const guard = await requireActor(request, { allowGuests: true, touch: false });
  if (guard.error) {
    // No session, an ended one, or one that no longer names a servable identity (a deleted
    // user, an expired guest token): a read answers "signed out" — and clears a cookie that
    // names nothing — while "stay signed in" is refused like any other request on it. A forged
    // or cross-origin POST, an outage or an account refusal is the coded refusal either way.
    const code = touch
      ? null
      : ((await guard.error.clone().json()) as { code?: string }).code;
    if (code === "auth.required") return signedOut(false);
    if (code === "auth.token_invalid" || code === "auth.guest_invalid")
      return signedOut(true);
    return noStore(guard.error);
  }
  let session: LiveSession = guard.session;
  if (touch) session = await keepAlive(session);
  const actor = guard.actor;
  return noStore(
    NextResponse.json({
      authenticated: true,
      user:
        actor.kind === "guest"
          ? { userId: actor.id, email: "", emailVerified: false, isGuest: true }
          : {
              userId: actor.user.sub,
              email: actor.user.email,
              emailVerified: actor.user.emailVerified,
              isGuest: false,
            },
      csrfToken: session.csrfToken,
      audience: session.audience,
      idleExpiresAt: session.idleAt,
      absoluteExpiresAt: session.absoluteAt,
      idleWarningSeconds: STAFF_IDLE_WARNING_SECONDS,
    })
  );
}

export const GET = tenantRoute(async function GET(request: NextRequest) {
  // Every page load reads this once (and a staff tab every 30 seconds), so a signed-in browser
  // is counted as its own session — the cookie's value, hashed; never the id itself — not as
  // its address, which an office or a school shares. A request naming no session is counted by
  // its address. Before any work, as every limit is (ADR-052); a made-up cookie value gets a
  // count of its own and then finds no session, which costs what it costs on any user route.
  const presented = presentedSessionId(request);
  const limited = await enforceRateLimit(
    request,
    DEFAULT_RULES.AUTH_SESSION_STATUS,
    presented ? { actorId: `session:${hashSessionId(presented)}` } : {}
  );
  if (limited) return limited;
  return describe(request, false);
});

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;
  return describe(request, true);
});
