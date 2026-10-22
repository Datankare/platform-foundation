/**
 * platform/auth/admin-guard.ts — Admin route guard
 *
 * requireAdmin verifies the caller, checks the route's permission and the caller's account
 * standing (a suspended or banned staff member has no powers), and returns the verified admin, so the route can attribute what it does (TASK-138) and apply the role rules
 * (platform/auth/role-governance.ts, TASK-145). adminGuard is the same check for routes that
 * only need a yes or no.
 *
 * In development (ADMIN_DEV_BYPASS=true, never in a production build), the checks are skipped
 * so the admin UI can be exercised on localhost; the bypass admin holds every permission and is
 * recorded under the nil id.
 *
 * @module platform/auth
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/platform/auth/middleware";
import { getCachedPermissions } from "@/platform/auth/permissions-cache";
import { isInGoodStanding } from "@/platform/auth/account-status-guard";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { apiError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

export type { VerifiedAdmin } from "@/platform/auth/role-governance";

const DEV_BYPASS = process.env.ADMIN_DEV_BYPASS === "true";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** The local development bypass admin (never in a production build). */
export const DEV_BYPASS_ADMIN: VerifiedAdmin = {
  userId: "00000000-0000-0000-0000-000000000000",
  sub: "dev-admin",
  roleName: "dev-bypass",
  permissions: ["*"],
};

export type AdminResult =
  | { readonly admin: VerifiedAdmin; readonly error?: never }
  | { readonly admin?: never; readonly error: NextResponse };

function unavailable(request: NextRequest, err: unknown): NextResponse {
  logger.error("Admin guard could not resolve permissions", {
    route: "platform/auth/admin-guard",
    error: err instanceof Error ? err.message : String(err),
  });
  return apiError("service.unavailable", { params: { service: "permissions" }, request });
}

/**
 * Guard an admin API route and return the verified admin. Rate limited per network address
 * before any verification, in the shared store (ADR-052).
 */
export async function requireAdmin(
  request: NextRequest,
  permission: string
): Promise<AdminResult> {
  const limited = await enforceRateLimit(request, DEFAULT_RULES.ADMIN_OPS);
  if (limited) return { error: limited };

  if (DEV_BYPASS && !IS_PRODUCTION) return { admin: DEV_BYPASS_ADMIN };

  const auth = await requireAuth(request);
  if (auth.error) return { error: auth.error };

  // The permission and standing lookups need the database. If it cannot be reached the answer
  // is "unavailable" (503) — never a raw error, and never access.
  let effective: Awaited<ReturnType<typeof getCachedPermissions>>;
  try {
    effective = await getCachedPermissions(auth.user.sub);
  } catch (err) {
    return { error: unavailable(request, err) };
  }
  if (!effective || !effective.permissions.includes(permission)) {
    logger.warn("Permission denied", {
      permissionCode: permission,
      route: "platform/auth/admin-guard",
    });
    return {
      error: apiError("auth.permission_denied", { params: { permission }, request }),
    };
  }

  // A restricted, suspended or banned staff member exercises no privileged power (audit X-6).
  // Checked on every request, uncached, so a ban takes effect at once.
  let standing: boolean;
  try {
    standing = await isInGoodStanding(effective.userId);
  } catch (err) {
    return { error: unavailable(request, err) };
  }
  if (!standing) {
    logger.warn("Admin access refused — account not in good standing", {
      permissionCode: permission,
      route: "platform/auth/admin-guard",
    });
    return { error: apiError("account.restricted", { request }) };
  }

  return {
    admin: {
      userId: effective.userId,
      sub: auth.user.sub,
      roleName: effective.roleName,
      permissions: effective.permissions,
    },
  };
}

/**
 * Guard an admin API route. Returns null if access is granted, or a NextResponse error.
 * Use requireAdmin when the route acts on anything it must attribute.
 */
export async function adminGuard(
  request: NextRequest,
  permission: string
): Promise<NextResponse | null> {
  const result = await requireAdmin(request, permission);
  return result.error ?? null;
}
