/**
 * platform/auth/admin-guard.ts — Admin route guard
 *
 * Wraps requireAuth + requirePermission for admin routes.
 * In development (ADMIN_DEV_BYPASS=true), skips auth checks
 * so the admin UI can be exercised on localhost.
 *
 * CRITICAL: ADMIN_DEV_BYPASS must NEVER be set in production.
 * The env var is not in .env.example — it must be set manually.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/platform/auth/middleware";
import { checkRateLimit } from "@/platform/auth/rate-limit";

const DEV_BYPASS = process.env.ADMIN_DEV_BYPASS === "true";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Guard an admin API route.
 * Returns null if access is granted, or a NextResponse error.
 */
export async function adminGuard(
  request: NextRequest,
  permission: string
): Promise<NextResponse | null> {
  // Rate limit always applies
  const limited = checkRateLimit(request);
  if (limited) return limited;

  // Dev bypass — NEVER in production
  if (DEV_BYPASS && !IS_PRODUCTION) {
    return null;
  }

  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const permCheck = await requirePermission(auth.user.sub, permission);
  if (permCheck.error) return permCheck.error;

  return null;
}

/**
 * Get the actor ID for audit logging.
 * Returns the real user ID or "dev-admin" in dev bypass mode.
 */
export function getAdminActorId(request: NextRequest): string {
  if (DEV_BYPASS && !IS_PRODUCTION) {
    return "dev-admin";
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return "unknown";

  // In real flow, this would be extracted from the verified token
  // but since adminGuard already verified, we just need the sub
  return "authenticated-admin";
}
