/**
 * platform/auth/actor-guard.ts — Actor + account-status chain for routes (ADR-050 D4)
 *
 *   1. requireActor() — a signed-in user, or a signed guest where the route opts in
 *   2. checkAccountStatus(userId, feature) — users only
 *   3. the feature's permission (featurePermission(feature); platform/auth/feature-permissions.ts;
 *      TASK-194, audit C-4: the feature permissions were granted and never checked) — a user's
 *      from their account's role and entitlements, resolved by the account (users.id, round 1
 *      C3: a legacy row without a subject, a re-linked account); a guest's from the `guest`
 *      role (round 1 C2: removing can_translate from guest takes effect for guests). A signed-in
 *      user definitely refused a feature's permission on a route that serves guests is marked so
 *      the browser cannot continue as a guest instead (round 1 C2, as for a banned account:
 *      platform/auth/restricted-marker.ts); a role that cannot be read is 503 and marks nothing
 *      (round 2, N3).
 *   4. checkCoppaGate(userId, feature) — users only: a consent-gated feature is refused to an
 *      account whose age is unverified, or a child's without parental consent (audit X-16)
 *
 * Guests have no account, so there is no account status to check; their usage is bounded by
 * the governed guest allowance (7A B1), enforced by the route before any paid call, and by the
 * guest role's feature permissions (step 3). This is
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
import { featurePermission } from "@/platform/auth/feature-permissions";
import {
  accountPermissionStanding,
  hasGuestPermission,
} from "@/platform/auth/permissions-cache";
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
  if (actor.kind === "guest") {
    // The guest role's permission for the feature (round 1, C2).
    const permission = featurePermission(feature);
    if (permission && !(await hasGuestPermission(permission))) {
      logger.info("Actor guard: guest refused by the guest role's permission", {
        feature,
        permission,
        route: request.nextUrl.pathname,
      });
      return {
        error: apiError("auth.permission_denied", { params: { permission }, request }),
      };
    }
    return { actor };
  }

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
  // The feature's permission, from the caller's role and entitlements (audit C-4).
  const permission = featurePermission(feature);
  const standing = permission
    ? await accountPermissionStanding(actor.user.sub, actor.id, permission)
    : "held";
  if (standing === "unknown") {
    // The role could not be read: unavailable — never a refusal that marks the browser (N3).
    return {
      error: apiError("service.unavailable", {
        params: { service: "permissions" },
        request,
      }),
    };
  }
  if (standing === "lacking" && permission) {
    logger.info("Actor guard: access denied by the feature's permission", {
      userId: actor.id,
      feature,
      permission,
      route: request.nextUrl.pathname,
    });
    const refusal = apiError("auth.permission_denied", {
      params: { permission },
      request,
    });
    // Refused as themselves, the user does not get the feature as a guest instead (C2) — marked
    // only where a guest would get it: a route that serves guests (round 2, N3; the profile
    // routes do not, so a refused can_edit_profile marks nothing).
    if (options.allowGuests) markRestricted(refusal);
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
  "auth.permission_denied",
  ...(ACCOUNT_STATUS_REFUSAL_CODES ?? []),
  ...(COPPA_REFUSAL_CODES ?? []),
] as const satisfies readonly ErrorCode[];

export const REFUSAL_GUARDS: Readonly<Record<string, readonly ErrorCode[]>> = {
  requireActorWithStatus: ACTOR_GUARD_REFUSAL_CODES,
};
