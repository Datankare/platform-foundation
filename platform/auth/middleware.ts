/**
 * platform/auth/middleware.ts — Auth middleware for API routes
 *
 * Validates the JWT on every protected API request. Extracts the player's
 * identity and makes it available to the route handler.
 *
 * Three modes:
 * 1. requireAuth() — returns 401 if no valid token
 * 2. optionalAuth() — allows unauthenticated access, provides user if present
 * 3. requirePermission() — returns 403 if user lacks the permission
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
