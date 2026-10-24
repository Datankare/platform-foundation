/**
 * app/api/admin/roles/route.ts — Admin role management
 *
 * GET: List roles with permission details and timestamps
 *
 * Roles and permissions are the platform catalog every tenant shares (ADR-053 D5), read here in
 * the tenant's transaction (the catalog is readable, never writable, by the request role).
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantTx } from "@/platform/data";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger } from "@/lib/logger";
import { internalError } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";

type RoleRow = {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
};
type PermissionRow = { id: string; code: string; display_name: string; category: string };

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_roles");
  if (denied) return denied;

  let roles: RoleRow[];
  let rolePerms: { role_id: string; permission_id: string }[];
  let allPermissions: PermissionRow[];
  try {
    ({ roles, rolePerms, allPermissions } = await withTenantTx(async (tx) => ({
      roles: (
        await tx.query<RoleRow>(
          `select id, name, display_name, description, created_at, updated_at
             from roles order by sort_order, name`
        )
      ).rows,
      rolePerms: (
        await tx.query<{ role_id: string; permission_id: string }>(
          "select role_id, permission_id from role_permissions"
        )
      ).rows,
      allPermissions: (
        await tx.query<PermissionRow>(
          "select id, code, display_name, category from permissions order by category, code"
        )
      ).rows,
    })));
  } catch (error) {
    logger.error("Admin roles list failed", {
      error: error instanceof Error ? error.message : String(error),
      route: "api/admin/roles",
    });
    return internalError(error, { request, context: "Admin roles query failed" });
  }

  const permMap = new Map(
    allPermissions.map((p) => [
      p.id,
      { code: p.code, displayName: p.display_name, category: p.category },
    ])
  );

  const rolePermMap = new Map<
    string,
    { code: string; displayName: string; category: string }[]
  >();
  for (const rp of rolePerms) {
    const perm = permMap.get(rp.permission_id);
    if (perm) {
      if (!rolePermMap.has(rp.role_id)) rolePermMap.set(rp.role_id, []);
      rolePermMap.get(rp.role_id)!.push(perm);
    }
  }

  const result = roles.map((r) => {
    const perms = rolePermMap.get(r.id) || [];
    return {
      id: r.id,
      name: r.name,
      displayName: r.display_name,
      description: r.description,
      permissionCount: perms.length,
      permissions: perms,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  });

  return NextResponse.json({
    roles: result,
    availablePermissions: allPermissions,
  });
});
