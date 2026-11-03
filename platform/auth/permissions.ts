/**
 * platform/auth/permissions.ts — Permissions engine
 *
 * Resolves a user's effective permissions from three sources:
 * 1. Primary role permissions (role_permissions table)
 * 2. Role inheritance (role_inheritance table)
 * 3. Additive entitlements (user_entitlements + entitlement_permissions)
 *
 * One transaction in the request's tenant (platform/data, ADR-053 D4): the user and their
 * entitlement grants are the tenant's rows (row-level security), the role, permission and
 * entitlement catalogs are platform tables every tenant reads.
 *
 * Sprint 3, Tasks 3.1 + 3.4
 */

import { withTenantTx, type Tx } from "@/platform/data";
import { logger } from "@/lib/logger";

export interface EffectivePermissions {
  userId: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  entitlementGroups: string[];
}

/**
 * Resolve all effective permissions for a user.
 * Combines: role permissions + inherited role permissions + entitlement permissions.
 *
 * Returns a deduplicated list of permission codes, or null when the user is not found or any
 * read fails — a partial set is never returned (fail closed: no permissions).
 */
export async function resolvePermissions(
  cognitoSub: string
): Promise<EffectivePermissions | null> {
  try {
    return await withTenantTx(async (tx) => {
      // 1. Get the user's role
      const users = await tx.query<{ id: string; role_id: string }>(
        "select id, role_id from users where cognito_sub = $1 and deleted_at is null",
        [cognitoSub]
      );
      const user = users.rows.length === 1 ? users.rows[0] : undefined;
      if (!user) {
        logger.warn("User not found for permission resolution", {
          cognitoSub,
          route: "platform/auth/permissions",
        });
        return null;
      }
      return resolveFor(tx, user);
    });
  } catch (err) {
    logger.warn("Permission resolution failed", {
      cognitoSub,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/permissions",
    });
    return null;
  }
}

/**
 * The permissions of the role named `roleName` — its own and those it inherits — or null when the
 * role is not found or the read fails (fail closed). A guest has no account but acts under the
 * `guest` role (TASK-194 round 1, C2): removing can_translate from guest takes effect for guests.
 */
export async function resolveRolePermissions(
  roleName: string
): Promise<EffectivePermissions | null> {
  try {
    return await withTenantTx(async (tx) => {
      const role = await tx.query<{ id: string }>(
        "select id from roles where name = $1",
        [roleName]
      );
      if (role.rows.length !== 1) return null;
      return resolveRoleCodes(tx, role.rows[0].id, roleName, "");
    });
  } catch (err) {
    logger.warn("Role permission resolution failed", {
      roleName,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/permissions",
    });
    return null;
  }
}

/**
 * Resolve the permissions of the account `userId` (users.id) — by the account, not the identity
 * (TASK-194 round 1, C3): an account whose cognito_sub is null (a legacy row) or that was re-linked
 * to a new identity is found by its id. Null when it is not found (or deleted) or a read fails.
 */
export async function resolveAccountPermissions(
  userId: string
): Promise<EffectivePermissions | null> {
  try {
    return await withTenantTx(async (tx) => {
      const users = await tx.query<{ id: string; role_id: string }>(
        "select id, role_id from users where id = $1::uuid and deleted_at is null",
        [userId]
      );
      const user = users.rows.length === 1 ? users.rows[0] : undefined;
      if (!user) return null;
      return resolveFor(tx, user);
    });
  } catch (err) {
    logger.warn("Permission resolution failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/permissions",
    });
    return null;
  }
}

/** A role's own and inherited permission codes (steps 3–4 and 6), in `tx`. */
async function resolveRoleCodes(
  tx: Tx,
  roleId: string,
  roleName: string,
  userId: string
): Promise<EffectivePermissions> {
  const rolePerms = await tx.query<{ code: string }>(
    `select p.code from permissions p where p.id in (
       select rp.permission_id from role_permissions rp where rp.role_id = $1
       union
       select rp.permission_id from role_permissions rp
         join role_inheritance ri on ri.inherits_from_id = rp.role_id
        where ri.role_id = $1)`,
    [roleId]
  );
  return {
    userId,
    roleId,
    roleName,
    permissions: rolePerms.rows.map((r) => r.code),
    entitlementGroups: [],
  };
}

/** Steps 2–6 for a found user, in the same transaction. */
async function resolveFor(
  tx: Tx,
  user: { id: string; role_id: string }
): Promise<EffectivePermissions> {
  // 2. Get role name
  const role = await tx.query<{ name: string }>("select name from roles where id = $1", [
    user.role_id,
  ]);
  const roleName = role.rows[0]?.name || "unknown";

  // 3–4. Direct and inherited role permissions
  const rolePerms = await tx.query<{ permission_id: string }>(
    `select rp.permission_id from role_permissions rp where rp.role_id = $1
     union
     select rp.permission_id from role_permissions rp
       join role_inheritance ri on ri.inherits_from_id = rp.role_id
      where ri.role_id = $1`,
    [user.role_id]
  );
  const permissionIds = new Set(rolePerms.rows.map((rp) => rp.permission_id));

  // 5. Entitlement permissions — only from grants that are not revoked and not expired, in
  //    groups that are active (audit X-14: expiry was never read and inactive groups still
  //    granted their permissions).
  const groups = await tx.query<{ id: string; code: string }>(
    `select distinct g.id, g.code
       from user_entitlements e
       join entitlement_groups g on g.id = e.entitlement_group_id
      where e.user_id = $1 and e.revoked_at is null
        and (e.expires_at is null or e.expires_at > now())
        and g.is_active`,
    [user.id]
  );
  const activeEntitlements = groups.rows.map((g) => g.code);
  const activeGroupIds = groups.rows.map((g) => g.id);

  if (activeGroupIds.length > 0) {
    const entitlementPerms = await tx.query<{ permission_id: string }>(
      "select permission_id from entitlement_permissions where entitlement_group_id = any($1::uuid[])",
      [activeGroupIds]
    );
    for (const ep of entitlementPerms.rows) permissionIds.add(ep.permission_id);
  }

  // 6. Resolve permission IDs to codes
  const permIdArray = Array.from(permissionIds);
  let permissionCodes: string[] = [];
  if (permIdArray.length > 0) {
    const perms = await tx.query<{ code: string }>(
      "select code from permissions where id = any($1::uuid[])",
      [permIdArray]
    );
    permissionCodes = perms.rows.map((p) => p.code);
  }

  return {
    userId: user.id,
    roleId: user.role_id,
    roleName,
    permissions: permissionCodes,
    entitlementGroups: activeEntitlements,
  };
}

/**
 * Check if a user has a specific permission.
 * Convenience wrapper around resolvePermissions.
 */
export async function hasPermission(
  cognitoSub: string,
  permissionCode: string
): Promise<boolean> {
  const effective = await resolvePermissions(cognitoSub);
  if (!effective) return false;
  return effective.permissions.includes(permissionCode);
}
