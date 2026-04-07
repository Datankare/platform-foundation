/**
 * app/api/admin/users/route.ts — Admin user management
 *
 * GET: List users (search, pagination)
 * PATCH: Update user role
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { writeAuditLog } from "@/platform/auth/audit";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_users");
  if (denied) return denied;

  const supabase = getSupabaseServiceClient();
  const url = new URL(request.url);
  const search = url.searchParams.get("q") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  let query = supabase
    .from("users")
    .select("id, email, display_name, role_id, created_at, deleted_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%`);
  }

  const { data, error } = await query;

  if (error) {
    logger.error("Admin users list failed", {
      error: error.message,
      route: "api/admin/users",
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Resolve role names
  const { data: roles } = await supabase.from("roles").select("id, name, display_name");

  const roleMap = new Map(
    (roles || []).map((r: { id: string; name: string }) => [r.id, r.name])
  );

  const users = (data || []).map(
    (p: {
      id: string;
      email: string | null;
      display_name: string | null;
      role_id: string;
      created_at: string;
      deleted_at: string | null;
    }) => ({
      id: p.id,
      email: p.email,
      displayName: p.display_name,
      roleName: roleMap.get(p.role_id) || "unknown",
      createdAt: p.created_at,
      isDeleted: !!p.deleted_at,
    })
  );

  return NextResponse.json({
    users,
    roles: (roles || []).map((r: { id: string; name: string; display_name: string }) => ({
      id: r.id,
      name: r.name,
      displayName: r.display_name,
    })),
  });
}

export async function PATCH(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_users");
  if (denied) return denied;

  const body = await request.json();
  const { userId, roleId } = body;

  if (!userId || !roleId) {
    return NextResponse.json({ error: "userId and roleId required" }, { status: 400 });
  }

  const supabase = getSupabaseServiceClient();

  // Get old role for audit
  const { data: user } = await supabase
    .from("users")
    .select("role_id")
    .eq("id", userId)
    .single();

  const { error } = await supabase
    .from("users")
    .update({ role_id: roleId })
    .eq("id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  invalidatePermissions(userId);

  await writeAuditLog({
    action: "role_changed",
    actorId: "dev-admin",
    targetId: userId,
    details: {
      oldRoleId: user?.role_id,
      newRoleId: roleId,
    },
  });

  return NextResponse.json({ success: true });
}
