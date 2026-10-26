/**
 * platform/auth/actor-guard.ts — Actor + account-status chain for routes (ADR-050 D4)
 *
 *   1. requireActor() — a signed-in user, or a signed guest where the route opts in
 *   2. checkAccountStatus(userId, feature) — users only
 *   3. checkCoppaGate(userId, feature) — users only: a consent-gated feature is refused to an
 *      account whose age is unverified, or a child's without parental consent (audit X-16)
 *
 * Guests have no account, so there is no account status to check; their usage is bounded by
 * the governed guest allowance (7A B1), enforced by the route before any paid call. This is
 * the platform form of a consumer's `requireAuthWithStatus`; consumers adopt it with an
 * explicit `allowGuests` per route.
 *
 * GenAI Principles: P4 (structural safety), P11 (fail-closed)
 *
 * @module platform/auth
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  AUTH_REFUSAL_CODES,
  requireActor,
  type Actor,
  type ActorOptions,
} from "@/platform/auth/middleware";
import {
  ACCOUNT_STATUS_REFUSAL_CODES,
  checkAccountStatus,
} from "@/platform/auth/account-status-guard";
import { trustedVerifiedClaim } from "@/platform/auth/email-verification";
import { checkCoppaGate, COPPA_REFUSAL_CODES } from "@/platform/auth/coppa-gate";
import { NO_GUEST_STATUSES, markRestricted } from "@/platform/auth/restricted-marker";
import { logger } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import type { ErrorCode } from "@/platform/errors/registry";

export type ActorGuardResult =
  | { readonly actor: Actor; readonly error?: never }
  | { readonly actor?: never; readonly error: NextResponse };

export async function requireActorWithStatus(
  request: NextRequest,
  feature: string,
  options: ActorOptions
): Promise<ActorGuardResult> {
  const result = await requireActor(request, options);
  if (result.error) return { error: result.error };

  const { actor } = result;
  if (actor.kind === "guest") return { actor };

  // The token's email seeds the user's row on first use (TASK-117) — stored verified only when
  // a trusted source verified it (review 16 L8: never an untrusted provider's claim).
  const status = await checkAccountStatus(actor.id, feature, {
    email: actor.user.email,
    emailVerified: trustedVerifiedClaim(actor.user),
  });
  if (!status.allowed && status.code === "account.not_provisioned") {
    return { error: apiError("account.not_provisioned", { request }) };
  }
  // An erased account (audit A-11): no access, and no detail about why.
  if (!status.allowed && status.code === "account.not_found") {
    return { error: apiError("account.not_found", { request }) };
  }
  if (!status.allowed) {
    logger.info("Actor guard: access denied by account status", {
      userId: actor.id,
      feature,
      accountStatus: status.accountStatus,
      route: request.nextUrl.pathname,
    });
    const refusal = apiError("account.restricted", {
      params: { feature, status: status.accountStatus ?? "unknown" },
      request,
    });
    // A banned or suspended account's browser cannot then continue as a guest (audit X-20).
    if (NO_GUEST_STATUSES.has(status.accountStatus ?? "")) markRestricted(refusal);
    return { error: refusal };
  }
  // Age and consent (COPPA), for every signed-in user on every route that names its feature.
  const coppa = await checkCoppaGate(actor.id, feature);
  if (!coppa.allowed) {
    logger.info("Actor guard: access denied by the age and consent gate", {
      userId: actor.id,
      feature,
      route: request.nextUrl.pathname,
    });
    return {
      error: apiError(coppa.code ?? "account.consent_required", {
        params: { feature },
        request,
      }),
    };
  }
  return { actor };
}

// ── TASK-181: the refusals this guard can return ─────────────────────────────────────────────
// Read by __tests__/refusal-coverage.test.ts: each route that calls a guard named here can
// return its codes, and every screen calling that route must handle each one. The test also
// checks this module's own apiError literals are all listed.
// (`?? []`: a suite that jest.mocks a guard module without these lists still loads.)

/** Everything requireActorWithStatus can refuse with: the caller, its account, its age. */
export const ACTOR_GUARD_REFUSAL_CODES = [
  ...(AUTH_REFUSAL_CODES ?? []),
  ...(ACCOUNT_STATUS_REFUSAL_CODES ?? []),
  ...(COPPA_REFUSAL_CODES ?? []),
] as const satisfies readonly ErrorCode[];

export const REFUSAL_GUARDS: Readonly<Record<string, readonly ErrorCode[]>> = {
  requireActorWithStatus: ACTOR_GUARD_REFUSAL_CODES,
};
