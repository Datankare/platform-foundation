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
 * the limits allow.
 *
 * Step-up (TASK-194, audit C-3): a route that changes an existing factor — /disable, and /setup
 * when the account already has one (re-enrolment would let a new authenticator replace it) — needs
 * proof of the current factor, not only a valid token: `{ password, currentCode }`, checked by the
 * identity provider in a fresh sign-in challenge (AuthProvider.confirmCurrentFactor). Before, a
 * bearer token alone turned off a staff member's second factor or enrolled an attacker's
 * authenticator through these routes, and with a phished password the attacker then passed
 * requireAdmin's MFA check for good. The step-up binds THESE routes only: the access token is in
 * the browser's localStorage with the aws.cognito.signin.user.admin scope, so a stolen token can
 * still call Cognito's own API (SetUserMFAPreference, AssociateSoftwareToken) directly — an
 * accepted residual until server-side sessions (batch S9; docs/SECURITY_DEBT.md SEC-016). A refused
 * step-up is recorded (`login_failed`, method `mfa_step_up`); the change itself is recorded as
 * before. First-time enrolment (no factor yet) is unchanged, and /verify completes only an
 * enrolment /setup started (Cognito verifies a pending secret). FACTOR_CHANGING_ROUTES lists the
 * routes; __tests__/mfa-step-up.test.ts holds each to it. A federated (SSO) account with no pool
 * password cannot make the proof: the provider answers auth.step_up_unavailable, the factor stays,
 * and recovery is the operator-assisted reset in docs/TENANCY_OPERATIONS.md ("Resetting two-step
 * verification") — never a bypass here.
 *
 * Turning MFA on or off is recorded
 * (mfa_enabled / mfa_disabled) before the answer, and an MFA change whose record cannot be
 * written answers 503 — the change itself is the provider's and has been made by then, so the
 * record says what happened rather than what was attempted.
 *
 * @module platform/auth
 */

import { revokeTokenVerification } from "@/platform/auth/token-verification";
import { NextRequest, NextResponse } from "next/server";
import { callAuthProvider } from "@/platform/auth/auth-response";
import { recordAuthEvent } from "@/platform/auth/auth-events";
import { auditableAccountId } from "@/platform/auth/account-identity";
import { apiError, errorFromResult, readJsonObject } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

const TOTP = /^\d{6}$/;

/** The caller the route verified (requireAuth). */
export interface MfaCaller {
  /** `mfaEnabled`: whether the account has a second factor now (read with the token). */
  readonly user: { readonly sub: string; readonly mfaEnabled?: boolean };
  readonly accessToken: string;
}

/**
 * The MFA routes that change an existing second factor, and when: each must refuse a caller who
 * has not proved the current factor (step-up). `whenEnrolled`: only when a factor exists.
 */
export const FACTOR_CHANGING_ROUTES: Readonly<
  Record<string, { readonly whenEnrolled: boolean }>
> = {
  "app/api/auth/mfa/disable/route.ts": { whenEnrolled: false },
  "app/api/auth/mfa/setup/route.ts": { whenEnrolled: true },
};

/** Whether the account may already have a factor: anything but a definite "no" (fail closed). */
const mayHaveFactor = (caller: MfaCaller) => caller.user.mfaEnabled !== false;

export type SteppedUp =
  { readonly ok: true } | { readonly ok: false; readonly response: Response };

/**
 * Proof of the current factor for `purpose`: the body's password and current code, confirmed by
 * the provider. A missing or malformed proof is auth.step_up_required; a wrong one is the
 * provider's code (auth.invalid_credentials, auth.code_invalid), recorded as a failed sign-in.
 */
async function steppedUp(
  request: NextRequest,
  caller: { sub: string; accessToken: string },
  purpose: "disable" | "re-enrol"
): Promise<SteppedUp> {
  // No body, or one that is not an object, carries no proof: the step-up is asked for.
  const read = await readJsonObject(request);
  const { password, currentCode } = (read.ok ? read.body : {}) as {
    password?: unknown;
    currentCode?: unknown;
  };
  return confirmStepUp({ request, caller, purpose, password, currentCode });
}

/**
 * A fresh step-up of the token's own user, for any route that grants or changes authority
 * (TASK-194; round 1, B1 — the delegation consent reuses it): `password`, and `currentCode` (six
 * digits) from the enrolled authenticator, confirmed by the identity provider in a fresh sign-in
 * (AuthProvider.confirmCurrentFactor). `allowPasswordOnly`: an account with no second factor
 * proves itself with its password alone (the provider refuses a missing code when one is
 * enrolled). A missing or malformed proof is auth.step_up_required; a wrong one is the provider's
 * code, recorded as a failed sign-in (`login_failed`, method `mfa_step_up`, the purpose).
 */
export async function confirmStepUp(args: {
  readonly request: NextRequest;
  readonly caller: { readonly sub: string; readonly accessToken: string };
  readonly purpose: string;
  readonly password: unknown;
  readonly currentCode: unknown;
  readonly allowPasswordOnly?: boolean;
}): Promise<SteppedUp> {
  const { request, caller, purpose, password, currentCode } = args;
  const codeGiven =
    currentCode !== undefined && currentCode !== null && currentCode !== "";
  if (
    !caller.sub ||
    !caller.accessToken ||
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 256 ||
    (codeGiven && (typeof currentCode !== "string" || !TOTP.test(currentCode))) ||
    (!codeGiven && !args.allowPasswordOnly)
  ) {
    return { ok: false, response: apiError("auth.step_up_required", { request }) };
  }
  const code = codeGiven ? (currentCode as string) : null;
  const called = await callAuthProvider(
    (auth) => auth.confirmCurrentFactor(caller.accessToken, password, code),
    { request, context: "MFA step-up failed" }
  );
  if (!called.ok) return { ok: false, response: called.response };
  if (!called.result.success) {
    const actorId = await auditableAccountId(caller.sub);
    // Best effort: the refusal stands whether or not it is recorded.
    await recordAuthEvent(
      {
        action: "login_failed",
        actorId,
        targetId: actorId,
        details: { method: "mfa_step_up", purpose },
      },
      request
    );
    return {
      ok: false,
      response: errorFromResult(called.result, {
        request,
        context: "MFA step-up failed",
      }),
    };
  }
  return { ok: true };
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
  // Re-enrolment replaces the factor: it needs proof of the current one (audit C-3).
  const reEnrol = mayHaveFactor(verifiedCaller);
  if (reEnrol) {
    const proof = await steppedUp(request, caller, "re-enrol");
    if (!proof.ok) return proof.response;
  }
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
  const actorId = await auditableAccountId(caller.sub);
  const recorded = await recordAuthEvent(
    {
      action: "mfa_enabled",
      actorId,
      targetId: actorId,
      // A re-enrolment (a factor existed): the new authenticator replaced it, after step-up.
      details: {
        factor: "totp",
        ...(mayHaveFactor(verifiedCaller) ? { replaced: true } : {}),
      },
    },
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
  // Removing the factor needs proof of it (audit C-3).
  const proof = await steppedUp(request, caller, "disable");
  if (!proof.ok) return proof.response;
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
  const actorId = await auditableAccountId(caller.sub);
  const recorded = await recordAuthEvent(
    {
      action: "mfa_disabled",
      actorId,
      targetId: actorId,
      details: { factor: "totp", stepUp: "password+current_code" },
    },
    request
  );
  if (!recorded) {
    return apiError("service.unavailable", { params: { service: "audit" }, request });
  }
  return noStore(NextResponse.json({ success: true, mfaEnabled: false }));
}
