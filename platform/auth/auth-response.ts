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
