/**
 * platform/auth/middleware.ts — Auth middleware for API routes
 *
 * Validates the JWT on every protected API request. Extracts the player's
 * identity and makes it available to the route handler.
 *
 * Two modes:
 * 1. requireAuth() — returns 401 if no valid token
 * 2. optionalAuth() — allows unauthenticated access, provides user if present
 *
 * Usage in API routes:
 *
 *   import { requireAuth } from "@/platform/auth/middleware";
 *
 *   export async function GET(request: NextRequest) {
 *     const auth = await requireAuth(request);
 *     if (auth.error) return auth.error;
 *     // auth.user is the verified TokenPayload
 *     // auth.accessToken is the raw JWT for Supabase player client
 *   }
 *
 * ADR-012: Cognito JWT validated on every protected route.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthProvider } from "@/platform/auth/config";
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
 *
 * Extracts Bearer token from Authorization header, verifies it via the
 * registered AuthProvider, and returns the decoded user payload.
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

  const accessToken = authHeader.slice(7); // Remove "Bearer "

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
 * Returns the user payload if a valid token is present, null otherwise.
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
    return { user: null, accessToken: null };
  }
}

/**
 * Require a specific permission. Returns 403 if the user doesn't have it.
 * Must be called AFTER requireAuth() — needs the user's identity.
 *
 * Usage:
 *   const auth = await requireAuth(request);
 *   if (auth.error) return auth.error;
 *   const permCheck = await requirePermission(auth.user.sub, "can_translate");
 *   if (permCheck.error) return permCheck.error;
 */
export async function requirePermission(
  userId: string,
  permissionCode: string
): Promise<{ granted: true; error?: never } | { granted?: never; error: NextResponse }> {
  // This will be implemented in Sprint 3 when the permissions engine is built.
  // For now, it's a placeholder that always grants — permissions enforcement
  // is wired in Sprint 3, Task 3.2.
  //
  // TODO: Sprint 3 — query role_permissions + player_entitlements via Supabase
  // to check if the player has the required permission.
  void userId;
  void permissionCode;
  return { granted: true };
}
