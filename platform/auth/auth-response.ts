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

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
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
import { recordAuthEvent, recordLastSignIn } from "./auth-events";
import { auditableAccountId } from "./account-identity";
import {
  getPreviousRefreshCookieKey,
  getRefreshCookieKey,
} from "@/platform/providers/environment-contract";
import { clearSessionCookie, startSession } from "@/platform/auth/session";

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
    // Never a token, whatever the provider's result carries (ADR-057 D1): a route that ends in a
    // session answers through sessionResponse, which keeps them on the server.
    const {
      error: _error,
      accessToken: _accessToken,
      refreshToken: _refreshToken,
      idToken: _idToken,
      ...rest
    } = result as T & Record<string, unknown>;
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
// Sessions (ADR-057; audit X-17, A-12, A-14, A-17)
// ---------------------------------------------------------------------------

/**
 * Before ADR-057 the refresh token lived in this httpOnly cookie (`<user id>.<mac>.<refresh
 * token>`, HMAC-SHA256 under REFRESH_COOKIE_KEY — review 17 M1) and the access token in the
 * browser's storage. Now neither reaches the browser: the session is a server-side record
 * (platform/auth/session.ts). The cookie is only ever READ — once, by POST
 * /api/auth/session/migrate, to move a browser signed in before the change onto a server-side
 * session without a new sign-in — and cleared by every sign-in and sign-out. Nothing sets it.
 * REFRESH_COOKIE_KEY (and _PREVIOUS) verify it until the refresh-token lifetime (30 days) has
 * passed since the deploy; then both settings are removed. Without the key no legacy cookie
 * verifies, and those browsers sign in again.
 */
export const LEGACY_REFRESH_COOKIE = "pf_refresh";
export const LEGACY_REFRESH_COOKIE_PATH = "/api/auth";
/** The page proxy's old session indicator (script-readable; never a credential). Cleared. */
export const LEGACY_SESSION_INDICATOR_COOKIE = "pf_has_session";

/** `<user id>.<mac: 43 base64url characters>.<refresh token>`. */
const SIGNED_COOKIE = /^([\w-]{1,128})\.([\w-]{43})\.(.+)$/;
/** Domain separation: this key signed nothing else. */
const COOKIE_MAC_LABEL = "pf_refresh.v1";

/** The keys a legacy cookie may be verified with; none when the key is not configured. */
function legacyCookieKeys(): string[] {
  const current = getRefreshCookieKey();
  if (!current) return [];
  const previous = getPreviousRefreshCookieKey();
  return previous && previous !== current ? [current, previous] : [current];
}

interface CookieWriter {
  readonly cookies: {
    set(name: string, value: string, options: Record<string, unknown>): unknown;
  };
}

/**
 * A legacy refresh cookie's user id and token, or null when it is absent, malformed, or its MAC
 * fails under every key (review 17 M1: the id is the one the token was issued with, or nothing).
 */
export function readLegacyRefreshCookie(
  value: string | undefined
): { readonly userId: string; readonly refreshToken: string } | null {
  if (!value || value.length > 8192) return null;
  const m = SIGNED_COOKIE.exec(value);
  if (!m) return null;
  const [, userId, mac, refreshToken] = m;
  const given = Buffer.from(mac, "base64url");
  if (given.length !== 32) return null;
  for (const key of legacyCookieKeys()) {
    const expected = createHmac("sha256", key)
      .update(`${COOKIE_MAC_LABEL}\0${userId}\0${refreshToken}`)
      .digest();
    if (timingSafeEqual(given, expected)) return { userId, refreshToken };
  }
  return null;
}

/** Remove what a browser signed in before ADR-057 still holds: the refresh cookie, the indicator. */
export function clearLegacyCookies(response: CookieWriter): void {
  response.cookies.set(LEGACY_REFRESH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: LEGACY_REFRESH_COOKIE_PATH,
    maxAge: 0,
  });
  response.cookies.set(LEGACY_SESSION_INDICATOR_COOKIE, "", {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** End the browser's session: the session cookie, and anything a legacy sign-in left. */
export function clearSessionCookies(response: CookieWriter): void {
  clearSessionCookie(response);
  clearLegacyCookies(response);
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
export type SignInMethod = "password" | "mfa" | "new_password" | "sso" | "migrated";

/**
 * The response for a sign-in step (sign-in, its MFA and new-password challenges, SSO, a legacy
 * browser's migration). On success the provider's tokens stay on the server: they are sealed
 * into a new server-side session (startSession — always a new id) and the browser receives only
 * that session's cookie. The body is `{ success: true, userId }` plus `extra` — never a token
 * (ADR-057 D1; __tests__/no-client-tokens.test.ts). The session is started only after its
 * `login_success` record is written — otherwise the provider's tokens are revoked and the answer
 * is 503. A failure is recorded as `login_failed` (best effort) and answered as before; a
 * challenge is answered as before.
 */
export async function sessionResponse(
  result: SessionResult,
  options: {
    request: NextRequest;
    context: string;
    method: SignInMethod;
    /** Extra fields for a successful response (never a token). */
    extra?: Record<string, unknown>;
  }
): Promise<NextResponse> {
  const { request, method } = options;
  if (result.success && result.accessToken && result.userId) {
    const discard = async () => {
      try {
        await getAuthProvider().signOut("", result.refreshToken);
      } catch {
        // The tokens were never handed out; they expire on their own.
      }
    };
    // The account the identity is bound to (TASK-174), so the record is the account's.
    const actorId = await auditableAccountId(result.userId);
    const recorded = await recordAuthEvent(
      { action: "login_success", actorId, targetId: actorId, details: { method } },
      request
    );
    if (!recorded) {
      await discard();
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    }
    // The account's last sign-in (TASK-185), best effort: never a reason to refuse the session.
    await recordLastSignIn(actorId, method);
    const response = NextResponse.json({
      success: true,
      userId: result.userId,
      ...(options.extra ?? {}),
    });
    response.headers.set("Cache-Control", "no-store");
    try {
      await startSession(request, response, {
        kind: "user",
        subject: result.userId,
        method,
        tokens: {
          kind: "user",
          accessToken: result.accessToken,
          ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
          expiresAt: Math.floor(Date.now() / 1000) + (result.expiresIn ?? 3600),
        },
      });
    } catch (err) {
      await discard();
      return internalError(err, { request, context: options.context });
    }
    clearLegacyCookies(response);
    return response;
  }
  if (result.success) {
    // A "success" without a user or a token is no session: never answered as one.
    return internalError(new Error("sign-in result carries no session"), {
      request,
      context: options.context,
    });
  }
  if (!isChallenge(result)) {
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
