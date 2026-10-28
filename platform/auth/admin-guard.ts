/**
 * platform/auth/admin-guard.ts — Admin route guard
 *
 * requireAdmin verifies the caller, checks the route's permission, the caller's account standing
 * (a suspended or banned staff member has no powers) and second factor (staff sign in with MFA
 * while auth.staff_mfa_required is on, audit A-9), and returns the verified admin, so the route
 * can attribute what it does (TASK-138) and apply the role rules
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
import { AUTH_REFUSAL_CODES, requireAuth } from "@/platform/auth/middleware";
import { getCachedPermissions } from "@/platform/auth/permissions-cache";
import { isInGoodStanding } from "@/platform/auth/account-status-guard";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { apiError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import { getConfig } from "@/platform/auth/platform-config";
import { withTenantTx } from "@/platform/data";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import type { TokenPayload } from "@/platform/auth/types";
import type { ErrorCode } from "@/platform/errors/registry";

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

/** The governed setting: staff must sign in with a second factor (audit A-9). */
export const STAFF_MFA_KEY = "auth.staff_mfa_required";

/**
 * Whether staff must use MFA. On unless the setting says, as a boolean, that it is off: a
 * missing, unreadable or malformed setting keeps it on (fail closed).
 */
export async function staffMfaRequired(): Promise<boolean> {
  try {
    return (await getConfig<unknown>(STAFF_MFA_KEY, true)) !== false;
  } catch {
    return true;
  }
}

export type AdminResult =
  | {
      readonly admin: VerifiedAdmin;
      /**
       * What verified the request (the identity provider's answer for the token); absent for the
       * development bypass. The console's session read keeps the account's address in step from
       * it (TASK-185).
       */
      readonly user?: TokenPayload;
      readonly error?: never;
    }
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

  // Privileged: when the identity provider cannot answer, it fails closed (no stale grace).
  const auth = await requireAuth(request, { privileged: true });
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

  // Administrative power needs more than a password (audit A-9): a staff member signs in with a
  // second factor, or enrols first (POST /api/auth/mfa/setup). Only an explicit "yes" from the
  // provider counts — one that cannot say is refused while the setting is on.
  if (auth.user.mfaEnabled !== true && (await staffMfaRequired())) {
    logger.warn("Admin access refused — no second factor", {
      permissionCode: permission,
      route: "platform/auth/admin-guard",
    });
    return { error: apiError("auth.mfa_required", { request }) };
  }

  return {
    admin: {
      userId: effective.userId,
      sub: auth.user.sub,
      roleName: effective.roleName,
      permissions: effective.permissions,
    },
    user: auth.user,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The admin `userId` is now, re-verified without a request: their current permissions and
 * standing, in the current tenant. For running what they asked for after someone else approved
 * it (a held command-bar action, audit X-10) — the request is theirs, so it runs with their
 * authority as it stands now, not as it stood when they asked. Null when they no longer exist,
 * are not in good standing, or cannot be resolved (fail closed).
 */
export async function verifiedAdminById(userId: string): Promise<VerifiedAdmin | null> {
  if (!UUID.test(userId)) return null;
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ cognito_sub: string | null }>(
        "select cognito_sub from users where id = $1::uuid and deleted_at is null",
        [userId]
      )
    );
    const sub = rows[0]?.cognito_sub;
    if (!sub) return null;
    const effective = await getCachedPermissions(sub);
    if (!effective || effective.userId !== userId) return null;
    if (!(await isInGoodStanding(effective.userId))) return null;
    return {
      userId: effective.userId,
      sub,
      roleName: effective.roleName,
      permissions: effective.permissions,
    };
  } catch (err) {
    logger.error("Could not re-verify the requesting admin", {
      route: "platform/auth/admin-guard",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── TASK-181: the refusals this guard can return ─────────────────────────────────────────────
// Read by __tests__/refusal-coverage.test.ts: each route that calls a guard named here can
// return its codes, and every screen calling that route must handle each one. The test also
// checks this module's own apiError literals are all listed.
// (`?? []`: a suite that jest.mocks a guard module without these lists still loads.)

/** Everything requireAdmin / adminGuard can refuse with. */
export const ADMIN_GUARD_REFUSAL_CODES = [
  ...(AUTH_REFUSAL_CODES ?? []),
  "auth.permission_denied",
  "account.restricted",
  "auth.mfa_required",
  "rate.limited",
] as const satisfies readonly ErrorCode[];

export const REFUSAL_GUARDS: Readonly<Record<string, readonly ErrorCode[]>> = {
  requireAdmin: ADMIN_GUARD_REFUSAL_CODES,
  adminGuard: ADMIN_GUARD_REFUSAL_CODES,
};
