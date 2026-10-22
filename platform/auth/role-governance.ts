/**
 * platform/auth/role-governance.ts — Rules for changing roles and permissions (TASK-145)
 *
 * Every path that assigns a role, edits a role's permissions, creates or deletes a role, or
 * activates a permission-granting entitlement checks the verified admin against these rules
 * first — the admin pages and the AI command bar alike:
 *
 *   1. No one changes their own role.
 *   2. A protected role (super_admin) is assigned or changed only in the database.
 *   3. No one grants — or takes away — a permission they do not hold themselves.
 *
 * Pure functions over a VerifiedAdmin, so each rule is tested without a database.
 *
 * @module platform/auth
 */

import type { ErrorCode } from "@/platform/errors";

/** Why a rule refused a change: a coded error (ADR-051) and its parameters. */
export interface RoleRefusal {
  readonly code: ErrorCode;
  readonly params: Readonly<Record<string, string>>;
}

/** The admin a route verified (platform/auth/admin-guard.ts requireAdmin). */
export interface VerifiedAdmin {
  /** users.id — the actor recorded in the audit log. */
  readonly userId: string;
  /** The identity provider's subject. */
  readonly sub: string;
  readonly roleName: string;
  /** Effective permission codes; "*" only for the local development bypass. */
  readonly permissions: readonly string[];
}

/** Roles that cannot be assigned or changed through the API. */
export const PROTECTED_ROLES: readonly string[] = ["super_admin"];

/** Whether the admin holds `permission`. */
export function holds(admin: VerifiedAdmin, permission: string): boolean {
  return admin.permissions.includes("*") || admin.permissions.includes(permission);
}

/** Refuse when any of `permissions` is one the admin does not hold (rule 3). */
export function checkPermissionGrant(
  admin: VerifiedAdmin,
  permissions: readonly string[]
): RoleRefusal | null {
  const missing = permissions.find((p) => !holds(admin, p));
  return missing === undefined
    ? null
    : { code: "auth.grant_exceeds_own", params: { permission: missing } };
}

/** Refuse any change to a protected role's definition (rule 2). */
export function checkRoleEditable(roleName: string): RoleRefusal | null {
  return PROTECTED_ROLES.includes(roleName)
    ? { code: "auth.role_protected", params: { role: roleName } }
    : null;
}

type RoleShape = { readonly name: string; readonly permissions: readonly string[] };

/**
 * Refuse moving `targetUserId` from `currentRole` to `newRole` unless rules 1–3 allow it: the
 * admin must hold every permission of the new role (no granting) and of the current one (no
 * demoting someone who holds more than the admin), and neither may be protected.
 */
export function checkRoleAssignment(
  admin: VerifiedAdmin,
  targetUserId: string,
  newRole: RoleShape,
  currentRole: RoleShape | null
): RoleRefusal | null {
  for (const role of [newRole, currentRole]) {
    if (role && PROTECTED_ROLES.includes(role.name)) {
      return { code: "auth.role_database_only", params: { role: role.name } };
    }
  }
  if (targetUserId === admin.userId) return { code: "auth.role_self_change", params: {} };
  return checkPermissionGrant(admin, [
    ...newRole.permissions,
    ...(currentRole?.permissions ?? []),
  ]);
}
