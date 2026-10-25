/**
 * platform/auth/mfa-routes.ts — A signed-in user enrolls in, confirms and removes TOTP MFA (A-9)
 *
 * The provider had MFA set-up, verification and removal, and the sign-in screen answered the MFA
 * challenge, but no route let anyone enrol, so every account — staff included — signed in with
 * a password alone. The three routes under /api/auth/mfa call these:
 *
 *   POST /api/auth/mfa/setup   → { secretCode, qrCodeUri } — the authenticator app's secret
 *   POST /api/auth/mfa/verify  { code } → MFA on, after the first code is accepted
 *   POST /api/auth/mfa/disable → MFA off
 *
 * Each route rate-limits by address and verifies the caller's access token (requireAuth) before
 * calling these, which limit it per account as well: a 6-digit code is guessable only at the rate
 * the limits allow. Turning MFA on or off is recorded
 * (mfa_enabled / mfa_disabled) before the answer, and an MFA change whose record cannot be
 * written answers 503 — the change itself is the provider's and has been made by then, so the
 * record says what happened rather than what was attempted.
 *
 * @module platform/auth
 */

import { revokeTokenVerification } from "@/platform/auth/token-verification";
import { NextRequest, NextResponse } from "next/server";
import { callAuthProvider } from "@/platform/auth/auth-response";
import { auditableUserId, recordAuthEvent } from "@/platform/auth/auth-events";
import { apiError, errorFromResult, readJsonObject } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

const TOTP = /^\d{6}$/;

/** The caller the route verified (requireAuth). */
export interface MfaCaller {
  readonly user: { readonly sub: string };
  readonly accessToken: string;
}

type Verified =
  | { readonly ok: true; readonly sub: string; readonly accessToken: string }
  | { readonly ok: false; readonly response: NextResponse };

/** Per account as well as per address: codes are guessed one account at a time, from anywhere. */
async function verified(request: NextRequest, caller: MfaCaller): Promise<Verified> {
  const perAccount = await enforceRateLimit(request, DEFAULT_RULES.AUTH_LOGIN, {
    actorId: caller.user.sub,
  });
  if (perAccount) return { ok: false, response: perAccount };
  return { ok: true, sub: caller.user.sub, accessToken: caller.accessToken };
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/** POST /api/auth/mfa/setup — start enrolment: the secret for the authenticator app. */
export async function mfaSetup(
  request: NextRequest,
  verifiedCaller: MfaCaller
): Promise<Response> {
  const caller = await verified(request, verifiedCaller);
  if (!caller.ok) return caller.response;
  const called = await callAuthProvider((auth) => auth.setupMfa(caller.accessToken), {
    request,
    context: "MFA setup failed",
  });
  if (!called.ok) return called.response;
  const result = called.result;
  if (!result.success || !result.secretCode) {
    return errorFromResult(result, { request, context: "MFA setup failed" });
  }
  return noStore(
    NextResponse.json({
      success: true,
      secretCode: result.secretCode,
      qrCodeUri: result.qrCodeUri,
    })
  );
}

/** POST /api/auth/mfa/verify { code } — confirm enrolment with the first code. */
export async function mfaVerify(
  request: NextRequest,
  verifiedCaller: MfaCaller
): Promise<Response> {
  const caller = await verified(request, verifiedCaller);
  if (!caller.ok) return caller.response;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const code = (read.body as { code?: unknown }).code;
  if (typeof code !== "string" || !TOTP.test(code)) {
    return apiError("request.invalid_value", {
      params: { field: "code", allowed: ["a 6-digit code"] },
      request,
    });
  }
  const called = await callAuthProvider(
    (auth) => auth.verifyMfaSetup(caller.accessToken, code),
    { request, context: "MFA verification failed" }
  );
  if (!called.ok) return called.response;
  if (!called.result.success) {
    return errorFromResult(called.result, {
      request,
      context: "MFA verification failed",
    });
  }
  // The token's remembered verification carries mfaEnabled: voided, so the change holds at once.
  await revokeTokenVerification(caller.sub);
  const actorId = auditableUserId(caller.sub);
  const recorded = await recordAuthEvent(
    { action: "mfa_enabled", actorId, targetId: actorId, details: { factor: "totp" } },
    request
  );
  if (!recorded) {
    return apiError("service.unavailable", { params: { service: "audit" }, request });
  }
  return noStore(NextResponse.json({ success: true, mfaEnabled: true }));
}

/** POST /api/auth/mfa/disable — turn MFA off. */
export async function mfaDisable(
  request: NextRequest,
  verifiedCaller: MfaCaller
): Promise<Response> {
  const caller = await verified(request, verifiedCaller);
  if (!caller.ok) return caller.response;
  const called = await callAuthProvider((auth) => auth.disableMfa(caller.accessToken), {
    request,
    context: "MFA removal failed",
  });
  if (!called.ok) return called.response;
  if (!called.result.success) {
    return errorFromResult(called.result, { request, context: "MFA removal failed" });
  }
  // A staff member who turned MFA off is not served as having it (audit A-9).
  await revokeTokenVerification(caller.sub);
  const actorId = auditableUserId(caller.sub);
  const recorded = await recordAuthEvent(
    { action: "mfa_disabled", actorId, targetId: actorId, details: { factor: "totp" } },
    request
  );
  if (!recorded) {
    return apiError("service.unavailable", { params: { service: "audit" }, request });
  }
  return noStore(NextResponse.json({ success: true, mfaEnabled: false }));
}
