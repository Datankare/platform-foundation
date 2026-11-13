/**
 * app/api/auth/session/migrate/route.ts — move a browser signed in before ADR-057 onto a
 * server-side session, without a new sign-in (TASK-214)
 *
 * POST, no body. Before ADR-057 a signed-in browser held an access token in localStorage and its
 * refresh token in the httpOnly `pf_refresh` cookie. On its first load after the deploy the page
 * removes what its storage holds and calls this route once: the legacy cookie (MAC-checked — a
 * forged or edited one is no cookie) is exchanged with the identity provider, and the session it
 * gives is kept server-side like any sign-in's (sessionResponse, method `migrated`); the browser
 * leaves with the session cookie and nothing else. The token that was in localStorage is never
 * sent here and never trusted.
 *
 * Without a legacy cookie, or with one the provider refuses, the answer is `{ migrated: false }`
 * and the legacy cookies are cleared: the browser shows sign-in. Guests are not migrated — a
 * guest starts a new guest session.
 *
 * It has no session yet, so no session token to check; it must come from this origin (the
 * legacy cookie is SameSite=Strict besides).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  LEGACY_REFRESH_COOKIE,
  callAuthProvider,
  clearLegacyCookies,
  readLegacyRefreshCookie,
  sessionResponse,
} from "@/platform/auth/auth-response";
import { requestOriginVerdict } from "@/platform/auth/request-origin";
import { apiError } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { sessionTenantRefusal } from "@/platform/tenancy/identity";
import { sameId } from "@/platform/auth/same-id";

function notMigrated(): NextResponse {
  const response = NextResponse.json({ success: true, migrated: false });
  clearLegacyCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;

  if (requestOriginVerdict(request) !== "same") {
    return apiError("auth.csrf_failed", { request });
  }

  const cookie = readLegacyRefreshCookie(
    request.cookies.get(LEGACY_REFRESH_COOKIE)?.value
  );
  if (!cookie) return notMigrated();

  const called = await callAuthProvider(
    (auth) => auth.renewSession(cookie.refreshToken, cookie.userId),
    { request, context: "Session migration failed" }
  );
  if (!called.ok) return called.response;
  const outcome = called.result;
  if (outcome.kind === "unavailable") {
    // Not a refusal: the legacy cookie is kept, and the page tries again on its next load.
    return apiError("service.unavailable", { params: { service: "auth" }, request });
  }
  // The renewed session is the cookie's user's, or it is not used.
  if (outcome.kind === "refused" || !sameId(outcome.session.userId, cookie.userId)) {
    return notMigrated();
  }

  const result = {
    success: true,
    userId: outcome.session.userId,
    accessToken: outcome.session.accessToken,
    refreshToken: outcome.session.refreshToken,
    expiresIn: Math.max(0, outcome.session.expiresAt - Math.floor(Date.now() / 1000)),
  };
  // ADR-053 D2: the identity is still this tenant's, or gets no session here.
  const tenantRefusal = await sessionTenantRefusal(result, request);
  if (tenantRefusal) {
    clearLegacyCookies(tenantRefusal);
    return tenantRefusal;
  }
  return sessionResponse(result, {
    request,
    context: "Session migration failed",
    method: "migrated",
    extra: { migrated: true },
  });
});
