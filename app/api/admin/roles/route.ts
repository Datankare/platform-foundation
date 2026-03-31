/**
 * app/api/admin/roles/route.ts — Admin role management
 *
 * GET: List roles with permission details and timestamps
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_roles");
  if (denied) return denied;

  const supabase = getSupabaseServiceClient();

  const { data: roles, error } = await supabase
    .from("roles")
    .select("id, name, display_name, description, created_at, updated_at")
    .order("sort_order");

  if (error) {
    logger.error("Admin roles list failed", {
      error: error.message,
      route: "api/admin/roles",
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Get all role-permission mappings with permission details
  const { data: rolePerms } = await supabase
    .from("role_permissions")
    .select("role_id, permission_id");

  const { data: allPermissions } = await supabase
    .from("permissions")
    .select("id, code, display_name, category")
    .order("category");

  const permMap = new Map(
    (allPermissions || []).map(
      (p: { id: string; code: string; display_name: string; category: string }) => [
        p.id,
        { code: p.code, displayName: p.display_name, category: p.category },
      ]
    )
  );

  const rolePermMap = new Map<
    string,
    { code: string; displayName: string; category: string }[]
  >();
  for (const rp of rolePerms || []) {
    const roleId = rp.role_id as string;
    const permId = rp.permission_id as string;
    const perm = permMap.get(permId);
    if (perm) {
      if (!rolePermMap.has(roleId)) rolePermMap.set(roleId, []);
      rolePermMap.get(roleId)!.push(perm);
    }
  }

  const result = (roles || []).map(
    (r: {
      id: string;
      name: string;
      display_name: string;
      description: string;
      created_at: string;
      updated_at: string;
    }) => {
      const perms = rolePermMap.get(r.id) || [];
      return {
        id: r.id,
        name: r.name,
        displayName: r.display_name,
        description: r.description,
        permissionCount: perms.length,
        permissions: perms,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }
  );

  return NextResponse.json({
    roles: result,
    availablePermissions: allPermissions || [],
  });
}
