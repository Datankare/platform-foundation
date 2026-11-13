/**
 * platform/auth/middleware.ts — Auth middleware for API routes
 *
 * Verifies the caller of every protected API request from its server-side session (ADR-057): the
 * session cookie names a record in the request's tenant (platform/auth/session.ts — live, within
 * its lifetimes, and for a state-changing request from this origin with the session's token),
 * and the token that record holds is verified as before. Extracts the user's identity and makes
 * it available to the route handler.
 *
 * A user route never accepts an `Authorization: Bearer` credential (ADR-057 D8): a request that
 * brings one and no session is unauthenticated. Bearer credentials are for machines only — an
 * agent's delegation token on the agent routes, the jobs tick's secret — and those routes verify
 * them themselves (__tests__/user-route-credentials.test.ts keeps it so).
 *
 * Three modes:
 * 1. requireAuth() — returns 401 if no valid token
 * 2. optionalAuth() — allows unauthenticated access, provides user if present
 * 3. requirePermission() — returns 403 if user lacks the permission
 * 4. requireActor() — a signed-in user, or a guest where the route opts in (ADR-050 D4)
 *
 * Sprint 2: requireAuth + optionalAuth
 * Sprint 3: requirePermission (real implementation replacing placeholder)
 *
 * ADR-012: Cognito JWT validated on every protected route.
 *
 * ADR-053 D2/D3: every verifier also establishes the request's tenant from the verified
 * identity (platform/tenancy/request.ts) — a user's provider attribute, a guest token's `tid` —
 * and refuses an identity whose tenant is not the request's. The tenant is returned with the
 * identity and held in the request's tenant context for everything the route then does.
 */

import { TokenVerificationUnavailableError } from "@/platform/auth/token-verification";
import { resolveSession, type LiveSession } from "@/platform/auth/session";
import { sameId } from "@/platform/auth/same-id";
import { NextRequest, NextResponse } from "next/server";
import { getAuthProvider } from "@/platform/auth/config";
import { hasCachedPermission } from "@/platform/auth/permissions-cache";
import type { TokenPayload } from "@/platform/auth/types";
import { isGuestId, verifyGuestToken } from "@/platform/auth/guest-token";
import { logger, generateRequestId } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import {
  bindIdentityTenant,
  ensureRequestTenant,
  TENANCY_REFUSAL_CODES,
} from "@/platform/tenancy/request";
import type { TenantContext } from "@/platform/tenancy/context";
import { resolveAccountRecord } from "@/platform/auth/account-identity";
import { syncEmailVerification } from "@/platform/auth/email-verification";
import type { ErrorCode } from "@/platform/errors/registry";

export interface AuthContext {
  user: TokenPayload;
  /**
   * The server-side session that authenticated the request. It holds the provider's tokens
   * sealed; no route reads them (platform/auth/session-vault.ts names the uses).
   */
  session: LiveSession;
  /** The request's tenant: the verified user's (ADR-053 D2). */
  tenant: TenantContext;
  error?: never;
}

export interface AuthError {
  user?: never;
  session?: never;
  tenant?: never;
  error: NextResponse;
}

export type AuthResult = AuthContext | AuthError;

/** Options of the verifiers. */
export interface AuthOptions {
  /** A privileged route: fails closed when the identity provider cannot answer. */
  readonly privileged?: boolean;
  /**
   * False for a read that must not count as use of the session (its own status, polled to warn
   * before an idle sign-out). Default true.
   */
  readonly touch?: boolean;
}

/**
 * The user a live session names, verified: the session's token is checked by the provider
 * (signature, audience, expiry, the pool's record of the user) and must name the session's own
 * subject, in the request's tenant.
 */
async function verifySessionUser(
  request: NextRequest,
  session: LiveSession,
  options: AuthOptions
): Promise<AuthResult> {
  const requestId = generateRequestId();
  try {
    const auth = getAuthProvider();
    const payload = await auth.verifyToken(session.identityToken, {
      privileged: options.privileged === true,
    });

    if (!payload) {
      logger.warn("Session token invalid or expired", {
        requestId,
        route: request.nextUrl.pathname,
      });
      return {
        error: apiError("auth.token_invalid", { request }),
      };
    }

    // ADR-050 D4: guest ids are a reserved namespace — a provider can never vouch for one. And
    // the token must be the session's own user's: a record holding another's is not believed.
    if (isGuestId(payload.sub) || !sameId(payload.sub, session.subject)) {
      logger.warn("Session token names another subject than its session", {
        requestId,
        route: request.nextUrl.pathname,
      });
      return {
        error: apiError("auth.token_invalid", { request }),
      };
    }

    const bound = await bindIdentityTenant(payload.tenantId, request);
    if (bound.error) return { error: bound.error };
    return { user: payload, session, tenant: bound.tenant };
  } catch (err) {
    logger.error("Token verification failed", {
      requestId,
      route: request.nextUrl.pathname,
      error: err instanceof Error ? err.message : "Unknown error",
    });
    // The identity provider could not answer (throttled, down): not a signed-out user — a 503
    // the client retries, never a 401 that signs them out (platform/auth/token-verification.ts).
    if (err instanceof TokenVerificationUnavailableError) {
      return {
        error: apiError("service.unavailable", { params: { service: "auth" }, request }),
      };
    }
    return {
      error: apiError("auth.token_invalid", { request }),
    };
  }
}

/**
 * Require authentication: a live user session. Returns 401 without one. A guest's session is
 * not a user's (auth.sign_in_required); requireActor serves guests where a route opts in.
 */
export async function requireAuth(
  request: NextRequest,
  options: AuthOptions = {}
): Promise<AuthResult> {
  const resolved = await resolveSession(request, { touch: options.touch });
  if (resolved.error) {
    // A bearer credential is not a user's credential here (ADR-057 D8): it is never read.
    if (resolved.reason === "none") {
      logger.warn("No session", { route: request.nextUrl.pathname });
    }
    return { error: resolved.error };
  }
  if (resolved.session.kind !== "user") {
    return { error: apiError("auth.sign_in_required", { request }) };
  }
  return verifySessionUser(request, resolved.session, options);
}

// ---------------------------------------------------------------------------
// Actors — a signed-in user, or a guest on routes that opt in (ADR-050 D4, TASK-099)
// ---------------------------------------------------------------------------

export type Actor =
  | {
      readonly kind: "user";
      /**
       * The account (users.id) the verified identity is bound to (users.cognito_sub) — never
       * the subject itself: an account re-linked to a new identity pool keeps its id
       * (platform/auth/account-identity.ts, TASK-174). For a first request it is the id the
       * account is created with (the subject). The subject is `user.sub`.
       */
      readonly id: string;
      readonly tenantId: string;
      readonly user: TokenPayload;
    }
  | {
      readonly kind: "guest";
      readonly id: string;
      readonly tenantId: string;
      readonly expiresAt: number;
    };

export interface ActorContext {
  actor: Actor;
  /** The server-side session that authenticated the request (as AuthContext.session). */
  session: LiveSession;
  error?: never;
}

export interface ActorError {
  actor?: never;
  session?: never;
  error: NextResponse;
}

export type ActorResult = ActorContext | ActorError;

export interface ActorOptions {
  /** Opt-in: this route serves guests. Every other route requires a real user. */
  readonly allowGuests: boolean;
  /**
   * A route that acts on the account itself (its export, its deletion): it fails closed when the
   * identity provider cannot answer — no stale grace (review 8 M5).
   */
  readonly privileged?: boolean;
  /** As AuthOptions.touch. */
  readonly touch?: boolean;
}

/**
 * Require an actor. A guest's session holds a platform-signed guest token (`guest.…`), verified
 * by the platform's signed-token module directly — never by the auth provider — and is accepted
 * only when the route opts in with `allowGuests: true`. A user's session is verified as
 * requireAuth() does.
 *
 * A guest on a route that does not allow guests gets 401 with `code: "sign_in_required"`, so
 * the client can prompt for sign-in rather than show a generic failure.
 */
export async function requireActor(
  request: NextRequest,
  options: ActorOptions
): Promise<ActorResult> {
  const resolved = await resolveSession(request, { touch: options.touch });
  if (resolved.error) return { error: resolved.error };
  const session = resolved.session;

  if (session.kind === "guest") {
    const route = request.nextUrl.pathname;
    if (!options.allowGuests) {
      logger.info("Guest refused on a route that requires sign-in", { route });
      return {
        error: apiError("auth.sign_in_required", { request }),
      };
    }
    const verified = await verifyGuestToken(session.identityToken);
    if (!verified.valid || !sameId(verified.guestId, session.subject)) {
      logger.warn("Invalid or expired guest token", { route });
      return {
        error: apiError("auth.guest_invalid", { request }),
      };
    }
    const bound = await bindIdentityTenant(verified.tenantId, request);
    if (bound.error) return { error: bound.error };
    return {
      actor: {
        kind: "guest",
        id: verified.guestId,
        tenantId: bound.tenant.tenantId,
        expiresAt: verified.expiresAt,
      },
      session,
    };
  }

  const auth = await verifySessionUser(request, session, {
    privileged: options.privileged === true,
  });
  if (auth.error) return { error: auth.error };
  // The account the identity is bound to (TASK-174): what every account-keyed step that follows
  // (status, consent, export, erasure, sessions) reads. Unreadable: unavailable, never a guess.
  let account: Awaited<ReturnType<typeof resolveAccountRecord>>["resolution"];
  let address: Awaited<ReturnType<typeof resolveAccountRecord>>["address"];
  try {
    ({ resolution: account, address } = await resolveAccountRecord(auth.user.sub));
  } catch (err) {
    logger.error("The identity's account could not be resolved", {
      route: request.nextUrl.pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      error: apiError("service.unavailable", {
        params: { service: "accounts" },
        request,
      }),
    };
  }
  if (account.kind === "conflict") {
    // Its would-be id is another identity's account: never served to this one.
    logger.warn(
      "Identity refused: its account id is held by another identity's account",
      {
        route: request.nextUrl.pathname,
      }
    );
    // Not retryable (review 15 L4): account.not_provisioned told the client to retry.
    return { error: apiError("account.identity_conflict", { request }) };
  }
  // The address the provider verified (TASK-176, TASK-185): users.email_verified brought up to
  // date, and a missing or changed address recorded — from a trusted verified claim only, never
  // moving a banned account's address; written once per change (compared against the row just
  // read).
  if (account.kind === "bound" && address)
    await syncEmailVerification(account.accountId, address, auth.user);
  return {
    actor: {
      kind: "user",
      id: account.accountId,
      tenantId: auth.tenant.tenantId,
      user: auth.user,
    },
    session,
  };
}

/**
 * Optional authentication. Allows unauthenticated access. A session that is absent, ended or a
 * guest's, or whose tenant is not the request's, is treated as none; the request then has the
 * tenant of its address. `tenant` is null only when even that is refused (an address for no
 * tenant, or the directory unreadable) — the route must then refuse too.
 *
 * One refusal is not "treated as none": a state-changing request that presents a live session
 * and fails the forgery checks (its origin, the session's token). It is returned as `error`, and
 * the route must answer with it — an attacker's request is never served as an anonymous one in
 * the victim's browser (a route that then sets a cookie or starts a session would be a login
 * forgery).
 */
export async function optionalAuth(request: NextRequest): Promise<{
  user: TokenPayload | null;
  session: LiveSession | null;
  tenant: TenantContext | null;
  error?: NextResponse;
}> {
  const anonymous = async () => {
    const bound = await ensureRequestTenant(request);
    return { user: null, session: null, tenant: bound.tenant ?? null };
  };
  const resolved = await resolveSession(request);
  if (resolved.error) {
    return resolved.reason === "forgery"
      ? { ...(await anonymous()), error: resolved.error }
      : anonymous();
  }
  if (resolved.session.kind !== "user") return anonymous();
  const auth = await verifySessionUser(request, resolved.session, {});
  if (auth.error) return anonymous();
  return { user: auth.user, session: auth.session, tenant: auth.tenant };
}

/**
 * Require a specific permission. Returns 403 if the user doesn't have it.
 * Must be called AFTER requireAuth() — needs the user's identity.
 *
 * Uses the permissions cache (60s TTL) to avoid DB round-trips.
 *
 * Usage:
 *   const auth = await requireAuth(request);
 *   if (auth.error) return auth.error;
 *   const permCheck = await requirePermission(auth.user.sub, "can_translate");
 *   if (permCheck.error) return permCheck.error;
 */
export async function requirePermission(
  cognitoSub: string,
  permissionCode: string
): Promise<{ granted: true; error?: never } | { granted?: never; error: NextResponse }> {
  const hasAccess = await hasCachedPermission(cognitoSub, permissionCode);

  if (!hasAccess) {
    logger.warn("Permission denied", {
      cognitoSub,
      permissionCode,
      route: "platform/auth/middleware",
    });
    return {
      error: apiError("auth.permission_denied", {
        params: { permission: permissionCode },
      }),
    };
  }

  return { granted: true };
}

// ── TASK-181: the refusals this guard can return ─────────────────────────────────────────────
// Read by __tests__/refusal-coverage.test.ts: each route that calls a guard named here can
// return its codes, and every screen calling that route must handle each one. The test also
// checks this module's own apiError literals are all listed.
// (`?? []`: a suite that jest.mocks a guard module without these lists still loads.)

/** What verifying the caller can refuse with (requireAuth, requireActor, optionalAuth). */
export const AUTH_REFUSAL_CODES = [
  "auth.required",
  "auth.token_invalid",
  "auth.csrf_failed",
  "auth.sign_in_required",
  "auth.guest_invalid",
  "account.identity_conflict",
  "service.unavailable",
  ...(TENANCY_REFUSAL_CODES ?? []),
] as const satisfies readonly ErrorCode[];

export const REFUSAL_GUARDS: Readonly<Record<string, readonly ErrorCode[]>> = {
  requireAuth: AUTH_REFUSAL_CODES,
  requireActor: AUTH_REFUSAL_CODES,
  optionalAuth: AUTH_REFUSAL_CODES,
  requirePermission: [...(AUTH_REFUSAL_CODES ?? []), "auth.permission_denied"],
};
