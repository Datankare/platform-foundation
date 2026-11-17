/**
 * app/api/account/security/route.ts — how the signed-in account signs in, for its own pages
 * (TASK-224; E-126 and SF-app-083)
 *
 * GET → { mfaEnabled: true | false | null, signInMethod: "password" | "sso" }
 *
 * The account page shows whether two-step verification is on, and offers to turn it on or off;
 * the agent authorization page asks for an authenticator code only from an account that has one
 * (SF-app-083: the field was always shown). Neither could know: no route said. This one reads
 * what the session's own verification already holds — the identity provider's answer for this
 * user (`mfaEnabled`, read with the user at verification) and how this session signed in — and
 * nothing else: no token, no secret, no other account's state.
 *
 * `mfaEnabled: null` is "could not be told" (the provider's answer did not say), never "off": a
 * page shows it as unknown and asks again, and the routes that change a factor decide for
 * themselves, failing closed (platform/auth/mfa-routes.ts). A single sign-on session manages
 * neither a password nor a factor here (ADR-057 D7): `signInMethod: "sso"` says so.
 *
 * A user's own session only (a guest has no account), limited per address before any work
 * (ADR-052), never cached.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/platform/auth/middleware";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    mfaEnabled: { type: ["boolean", "null"] },
    signInMethod: { type: "string" },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL);
  if (limited) return limited;
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;
  const mfa = auth.user.mfaEnabled;
  const response = NextResponse.json({
    mfaEnabled: typeof mfa === "boolean" ? mfa : null,
    // Through a provider (single sign-on), or with a password.
    signInMethod: auth.session.method === "sso" ? "sso" : "password",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}, GET_RESPONSE);
