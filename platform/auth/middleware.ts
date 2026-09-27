/**
 * platform/auth/middleware.ts — Auth middleware for API routes
 *
 * Validates the JWT on every protected API request. Extracts the user's
 * identity and makes it available to the route handler.
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
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthProvider } from "@/platform/auth/config";
import { hasCachedPermission } from "@/platform/auth/permissions-cache";
import type { TokenPayload } from "@/platform/auth/types";
import {
  GUEST_TOKEN_PREFIX,
  isGuestId,
  verifyGuestToken,
} from "@/platform/auth/guest-token";
import { logger, generateRequestId } from "@/lib/logger";

export interface AuthContext {
  user: TokenPayload;
  accessToken: string;
  error?: never;
}

export interface AuthError {
  user?: never;
  accessToken?: never;
  error: NextResponse;
}

export type AuthResult = AuthContext | AuthError;

/**
 * Require authentication. Returns 401 if no valid token.
 */
export async function requireAuth(request: NextRequest): Promise<AuthResult> {
  const requestId = generateRequestId();
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Missing or malformed Authorization header", {
      requestId,
      route: request.nextUrl.pathname,
    });
    return {
      error: NextResponse.json({ error: "Authentication required" }, { status: 401 }),
    };
  }

  const accessToken = authHeader.slice(7);

  try {
    const auth = getAuthProvider();
    const payload = await auth.verifyToken(accessToken);

    if (!payload) {
      logger.warn("Invalid or expired token", {
        requestId,
        route: request.nextUrl.pathname,
      });
      return {
        error: NextResponse.json({ error: "Invalid or expired token" }, { status: 401 }),
      };
    }

    // ADR-050 D4: guest ids are a reserved namespace — a provider can never vouch for one.
    if (isGuestId(payload.sub)) {
      logger.warn("User token carries a guest-namespaced subject", {
        requestId,
        route: request.nextUrl.pathname,
      });
      return {
        error: NextResponse.json({ error: "Invalid or expired token" }, { status: 401 }),
      };
    }

    return { user: payload, accessToken };
  } catch (err) {
    logger.error("Token verification failed", {
      requestId,
      route: request.nextUrl.pathname,
      error: err instanceof Error ? err.message : "Unknown error",
    });
    return {
      error: NextResponse.json({ error: "Authentication failed" }, { status: 401 }),
    };
  }
}

// ---------------------------------------------------------------------------
// Actors — a signed-in user, or a guest on routes that opt in (ADR-050 D4, TASK-099)
// ---------------------------------------------------------------------------

export type Actor =
  | { readonly kind: "user"; readonly id: string; readonly user: TokenPayload }
  | { readonly kind: "guest"; readonly id: string; readonly expiresAt: number };

export interface ActorContext {
  actor: Actor;
  error?: never;
}

export interface ActorError {
  actor?: never;
  error: NextResponse;
}

export type ActorResult = ActorContext | ActorError;

export interface ActorOptions {
  /** Opt-in: this route serves guests. Every other route requires a real user. */
  readonly allowGuests: boolean;
}

/**
 * Require an actor. A guest token (`guest.…`) is verified by the platform's signed-token
 * module directly — never by the auth provider — and is accepted only when the route opts in
 * with `allowGuests: true`. Anything else goes through requireAuth().
 *
 * A guest on a route that does not allow guests gets 401 with `code: "sign_in_required"`, so
 * the client can prompt for sign-in rather than show a generic failure.
 */
export async function requireActor(
  request: NextRequest,
  options: ActorOptions
): Promise<ActorResult> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (token.startsWith(GUEST_TOKEN_PREFIX)) {
    const route = request.nextUrl.pathname;
    if (!options.allowGuests) {
      logger.info("Guest refused on a route that requires sign-in", { route });
      return {
        error: NextResponse.json(
          { error: "Sign in to use this feature", code: "sign_in_required" },
          { status: 401 }
        ),
      };
    }
    const verified = await verifyGuestToken(token);
    if (!verified.valid) {
      logger.warn("Invalid or expired guest token", { route });
      return {
        error: NextResponse.json(
          {
            error: "Guest session expired — start a new one or sign in",
            code: "guest_invalid",
          },
          { status: 401 }
        ),
      };
    }
    return {
      actor: { kind: "guest", id: verified.guestId, expiresAt: verified.expiresAt },
    };
  }

  const auth = await requireAuth(request);
  if (auth.error) return { error: auth.error };
  return { actor: { kind: "user", id: auth.user.sub, user: auth.user } };
}

/**
 * Optional authentication. Allows unauthenticated access.
 */
export async function optionalAuth(
  request: NextRequest
): Promise<{ user: TokenPayload | null; accessToken: string | null }> {
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { user: null, accessToken: null };
  }

  const accessToken = authHeader.slice(7);

  try {
    const auth = getAuthProvider();
    const payload = await auth.verifyToken(accessToken);
    return { user: payload, accessToken: payload ? accessToken : null };
  } catch {
    /* justified */
    // Token verification failed — return unauthenticated
    return { user: null, accessToken: null };
  }
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
      error: NextResponse.json(
        { error: "Permission denied", required: permissionCode },
        { status: 403 }
      ),
    };
  }

  return { granted: true };
}
