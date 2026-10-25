/**
 * platform/auth/auth-response.ts — HTTP response for an auth-provider result (ADR-051, TASK-109)
 *
 * Auth routes used to send every provider result with HTTP 200, failures included. Now:
 *   - success, and challenge steps (MFA, new password, email verification) → 200 with the result;
 *   - a failure → its error code and real status (401 wrong credentials, 409 account exists,
 *     429 too many attempts, …); an uncoded failure → a logged 500 with a request id.
 * The provider's English `error` never reaches the client on either path.
 *
 * @module platform/auth
 */

import { NextResponse } from "next/server";
import {
  apiError,
  errorFromResult,
  internalError,
  type CodedFailure,
} from "@/platform/errors";
import { initAuth } from "./auth-init";
import { getAuthProvider } from "./config";
import { getGlobalPasswordPolicy, passwordRuleViolations } from "./password-policy";
import type { AuthProvider } from "./provider";
import { auditableUserId, recordAuthEvent } from "./auth-events";

export interface ProviderResult extends CodedFailure {
  success: boolean;
  mfaRequired?: boolean;
  newPasswordRequired?: boolean;
  emailVerificationRequired?: boolean;
}

/** A result that asks the client for a next step rather than reporting a failure. */
export function isChallenge(result: ProviderResult): boolean {
  return Boolean(
    result.mfaRequired || result.newPasswordRequired || result.emailVerificationRequired
  );
}

export function authResultResponse<T extends ProviderResult>(
  result: T,
  options: {
    request?: { headers: Headers; nextUrl?: { pathname: string } };
    context?: string;
  } = {}
): NextResponse {
  if (result.success || isChallenge(result)) {
    const { error: _error, ...rest } = result;
    return NextResponse.json(rest);
  }
  return errorFromResult(result, options);
}

/**
 * Initialises the providers and calls the registered auth provider for a route. The platform's
 * providers report failures as results, but a provider is replaceable and may throw, and a
 * misconfigured server may register none: either is answered as a coded, logged 500 with a
 * request id, never an uncoded one (PF v5.1.0, PR-16).
 */
export async function callAuthProvider<T>(
  call: (auth: AuthProvider) => Promise<T>,
  options: {
    request: { headers: Headers; nextUrl?: { pathname: string } };
    context: string;
  }
): Promise<{ ok: true; result: T } | { ok: false; response: NextResponse }> {
  try {
    initAuth();
    return { ok: true, result: await call(getAuthProvider()) };
  } catch (err) {
    return { ok: false, response: internalError(err, options) };
  }
}

/**
 * Every route that sets a password (sign-up, password reset, the new-password challenge) checks
 * it against the policy its tenant's administrators set — read in the request's tenant — before
 * the provider sees it. Null when it passes; otherwise `auth.password_policy` naming the rules
 * it breaks.
 */
export async function passwordPolicyRefusal(
  password: string,
  request: { headers: Headers; nextUrl?: { pathname: string } }
): Promise<NextResponse | null> {
  const rules = passwordRuleViolations(password, await getGlobalPasswordPolicy());
  return rules.length > 0
    ? apiError("auth.password_policy", { params: { rules }, request })
    : null;
}

// ---------------------------------------------------------------------------
// Sessions (audit X-17, A-12, A-14, A-17)
// ---------------------------------------------------------------------------

/**
 * The refresh token lives in this cookie, never in the browser's script-readable storage: httpOnly
 * (no script reads it, so a cross-site script cannot take a 30-day credential), Secure in
 * production, SameSite=Strict, and sent only to the auth routes. Its value is
 * `<user id>.<refresh token>`: a confidential client refreshes with the user's id.
 */
export const REFRESH_COOKIE = "pf_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";
/** Cognito's default refresh-token lifetime; the provider still decides when it expires. */
export const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
/** The page proxy's session indicator (not a credential). */
export const SESSION_INDICATOR_COOKIE = "pf_has_session";

/** A provider user id the cookie can carry: no dot (the separator), nothing to encode. */
const COOKIE_USER_ID = /^[\w-]{1,128}$/;
const ID_PREFIXED = /^([\w-]{1,128})\.(.+)$/;

interface CookieWriter {
  readonly cookies: {
    set(name: string, value: string, options: Record<string, unknown>): unknown;
  };
}

/** The refresh cookie's user id and token, or null when it is absent or malformed. */
export function readRefreshCookie(
  value: string | undefined
): { readonly userId: string; readonly refreshToken: string } | null {
  if (!value || value.length > 8192) return null;
  const m = ID_PREFIXED.exec(value);
  return m ? { userId: m[1], refreshToken: m[2] } : null;
}

export function setRefreshCookie(
  response: CookieWriter,
  userId: string,
  refreshToken: string
): void {
  response.cookies.set(REFRESH_COOKIE, `${userId}.${refreshToken}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_COOKIE_MAX_AGE,
  });
}

/** Set the page proxy's indicator for `maxAge` seconds (0 clears it). */
export function setSessionIndicator(response: CookieWriter, maxAge: number): void {
  response.cookies.set(SESSION_INDICATOR_COOKIE, maxAge > 0 ? "true" : "", {
    httpOnly: false, // Read by the page proxy and the client; it grants nothing.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor(maxAge)),
  });
}

/** End the browser's session: the refresh cookie and the indicator. */
export function clearSessionCookies(response: CookieWriter): void {
  response.cookies.set(REFRESH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: 0,
  });
  setSessionIndicator(response, 0);
}

/** A provider result that may end in a session. */
export interface SessionResult extends ProviderResult {
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
}

/** How the session was obtained — recorded with each sign-in event. */
export type SignInMethod = "password" | "mfa" | "new_password" | "sso" | "refresh";

/**
 * The response for a sign-in step (sign-in, its MFA and new-password challenges, SSO). A session
 * is returned only after its `login_success` record is written — otherwise the provider's tokens
 * are revoked and the answer is 503 — and only as the access token: the refresh token goes into
 * the httpOnly cookie and the ID token is never returned (A-17). A failure is recorded as
 * `login_failed` (best effort) and answered as before; a challenge is answered as before.
 */
export async function sessionResponse(
  result: SessionResult,
  options: {
    request: { headers: Headers; nextUrl?: { pathname: string } };
    context: string;
    method: SignInMethod;
    /** Extra fields for a successful response (SSO: the identity's email). */
    extra?: Record<string, unknown>;
  }
): Promise<NextResponse> {
  const { request, method } = options;
  if (result.success && result.accessToken) {
    const actorId = auditableUserId(result.userId);
    const recorded = await recordAuthEvent(
      { action: "login_success", actorId, targetId: actorId, details: { method } },
      request
    );
    if (!recorded) {
      try {
        await getAuthProvider().signOut(result.accessToken, result.refreshToken);
      } catch {
        // The tokens were never handed out; they expire on their own.
      }
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    }
    const {
      error: _error,
      refreshToken,
      idToken: _idToken,
      ...rest
    } = result as SessionResult & Record<string, unknown>;
    const response = NextResponse.json({ ...rest, ...(options.extra ?? {}) });
    response.headers.set("Cache-Control", "no-store");
    if (refreshToken && result.userId && COOKIE_USER_ID.test(result.userId)) {
      setRefreshCookie(response, result.userId, refreshToken);
      setSessionIndicator(response, REFRESH_COOKIE_MAX_AGE);
    } else {
      setSessionIndicator(response, result.expiresIn ?? 3600);
    }
    return response;
  }
  if (!result.success && !isChallenge(result)) {
    await recordAuthEvent(
      {
        action: "login_failed",
        details: { method, code: result.errorCode ?? "internal.error" },
      },
      request
    );
  }
  return authResultResponse(result, { request, context: options.context });
}

// ---------------------------------------------------------------------------
// Account enumeration (audit A-15)
// ---------------------------------------------------------------------------

/**
 * The routes reachable before sign-in must not say whether an address has an account:
 *
 *   - `request`  (forgot password, resend verification): an unknown or unusable address is
 *                answered exactly as a known one — `{ success: true }`;
 *   - `create`   (sign-up): an address that already has an account is answered exactly as a new
 *                one — `{ success: true, emailVerificationRequired: true }`;
 *   - `code`     (confirm a reset, verify an email): an unknown address is answered as a wrong
 *                code.
 *
 * Rate limiting, a malformed request and a server failure are still answered as themselves —
 * they say nothing about the address.
 */
export type ConcealedStep = "request" | "create" | "code";

const REVEALS_ACCOUNT = new Set<string>([
  "auth.invalid_credentials", // the provider's "no such user"
  "auth.email_not_verified",
  "auth.account_exists",
]);

export function concealAccount<T extends ProviderResult>(
  result: T,
  step: ConcealedStep
): ProviderResult {
  if (result.success || !result.errorCode || !REVEALS_ACCOUNT.has(result.errorCode)) {
    return result;
  }
  if (step === "request") return { success: true };
  if (step === "create") {
    return result.errorCode === "auth.account_exists"
      ? { success: true, emailVerificationRequired: true }
      : result;
  }
  return { success: false, error: "concealed", errorCode: "auth.code_invalid" };
}
