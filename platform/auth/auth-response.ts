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
import { errorFromResult, type CodedFailure } from "@/platform/errors";

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
