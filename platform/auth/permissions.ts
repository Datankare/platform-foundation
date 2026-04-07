/**
 * platform/auth/permissions.ts — Permissions engine
 *
 * Resolves a user's effective permissions from three sources:
 * 1. Primary role permissions (role_permissions table)
 * 2. Role inheritance (role_inheritance table)
 * 3. Additive entitlements (user_entitlements + entitlement_permissions)
 *
 * Uses the Supabase service client (bypasses RLS) because permission
 * checks happen server-side in middleware before the user context exists.
 *
 * Sprint 3, Tasks 3.1 + 3.4
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
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
 * Returns a deduplicated list of permission codes.
 */
export async function resolvePermissions(
  cognitoSub: string
): Promise<EffectivePermissions | null> {
  const supabase = getSupabaseServiceClient();

  // 1. Get the user's role
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, role_id")
    .eq("cognito_sub", cognitoSub)
    .is("deleted_at", null)
    .single();

  if (userError || !user) {
    logger.warn("User not found for permission resolution", {
      cognitoSub,
      error: userError?.message,
      route: "platform/auth/permissions",
    });
    return null;
  }

  // 2. Get role name
  const { data: role } = await supabase
    .from("roles")
    .select("name")
    .eq("id", user.role_id)
    .single();

  const roleName = role?.name || "unknown";

  // 3. Get direct role permissions
  const { data: rolePerms } = await supabase
    .from("role_permissions")
    .select("permission_id")
    .eq("role_id", user.role_id);

  const permissionIds = new Set(
    (rolePerms || []).map((rp: { permission_id: string }) => rp.permission_id)
  );

  // 4. Get inherited role permissions
  const { data: inheritedRoles } = await supabase
    .from("role_inheritance")
    .select("inherits_from_id")
    .eq("role_id", user.role_id);

  if (inheritedRoles && inheritedRoles.length > 0) {
    const inheritedRoleIds = inheritedRoles.map(
      (ir: { inherits_from_id: string }) => ir.inherits_from_id
    );
    const { data: inheritedPerms } = await supabase
      .from("role_permissions")
      .select("permission_id")
      .in("role_id", inheritedRoleIds);

    for (const ip of inheritedPerms || []) {
      permissionIds.add(ip.permission_id);
    }
  }

  // 5. Get entitlement permissions (active, not expired, not revoked)
  const { data: userEntitlements } = await supabase
    .from("user_entitlements")
    .select("entitlement_group_id")
    .eq("user_id", user.id)
    .is("revoked_at", null);

  const activeEntitlements: string[] = [];

  if (userEntitlements && userEntitlements.length > 0) {
    const now = new Date().toISOString();
    const entitlementGroupIds = userEntitlements
      .filter(
        (pe: { entitlement_group_id: string; expires_at?: string | null }) =>
          !pe.expires_at || pe.expires_at > now
      )
      .map((pe: { entitlement_group_id: string }) => pe.entitlement_group_id);

    if (entitlementGroupIds.length > 0) {
      // Get entitlement group codes for the response
      const { data: groups } = await supabase
        .from("entitlement_groups")
        .select("id, code")
        .in("id", entitlementGroupIds)
        .eq("is_active", true);

      for (const g of groups || []) {
        activeEntitlements.push(g.code);
      }

      // Get permissions from active entitlement groups
      const { data: entitlementPerms } = await supabase
        .from("entitlement_permissions")
        .select("permission_id")
        .in("entitlement_group_id", entitlementGroupIds);

      for (const ep of entitlementPerms || []) {
        permissionIds.add(ep.permission_id);
      }
    }
  }

  // 6. Resolve permission IDs to codes
  const permIdArray = Array.from(permissionIds);
  let permissionCodes: string[] = [];

  if (permIdArray.length > 0) {
    const { data: perms } = await supabase
      .from("permissions")
      .select("code")
      .in("id", permIdArray);

    permissionCodes = (perms || []).map((p: { code: string }) => p.code);
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
