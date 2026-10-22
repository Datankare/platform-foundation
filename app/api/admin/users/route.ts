/**
 * app/api/admin/users/route.ts — Admin user management
 *
 * GET: List users (search, pagination)
 * PATCH: Update user role
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { checkRoleAssignment } from "@/platform/auth/role-governance";
import { findRole, findUser } from "@/platform/auth/role-lookup";
import { auditedResponse } from "@/platform/auth/audit";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import { logger } from "@/lib/logger";
import { likeTerm, pageParams } from "@/lib/pagination";
import { apiError, internalError, readJsonObject } from "@/platform/errors";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_users");
  if (denied) return denied;

  const supabase = getSupabaseServiceClient();
  const params = new URL(request.url).searchParams;
  const term = likeTerm(params.get("q"));
  // A search reads the first offset+limit matches of each side: kept within the REST API's
  // default row cap (1,000), so a deep page is exact rather than silently truncated.
  const { limit, offset } = pageParams(params, {
    maxLimit: 100,
    maxOffset: term ? 900 : 10_000,
  });
  const COLUMNS = "id, email, display_name, role_id, created_at, deleted_at";

  // Search is two bound filters merged here — never a filter string built from input
  // (audit B-16: `q` was spliced into .or()). Each query returns the first offset+limit
  // matches, so the merged, re-sorted page is exact.
  type Row = {
    id: string;
    email: string | null;
    display_name: string | null;
    role_id: string;
    created_at: string;
    deleted_at: string | null;
  };
  let data: Row[] | null;
  let error: { message: string } | null;
  if (term) {
    const page = (column: string) =>
      supabase
        .from("users")
        .select(COLUMNS)
        .ilike(column, `%${term}%`)
        .order("created_at", { ascending: false })
        .range(0, offset + limit - 1);
    const [byEmail, byName] = await Promise.all([page("email"), page("display_name")]);
    error = byEmail.error ?? byName.error;
    const merged = new Map<string, Row>();
    for (const row of [...(byEmail.data ?? []), ...(byName.data ?? [])] as Row[]) {
      merged.set(row.id, row);
    }
    data = [...merged.values()]
      .sort((a, b) =>
        a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
      )
      .slice(offset, offset + limit);
  } else {
    const res = await supabase
      .from("users")
      .select(COLUMNS)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    data = res.data as Row[] | null;
    error = res.error;
  }

  if (error) {
    logger.error("Admin users list failed", {
      error: error.message,
      route: "api/admin/users",
    });
    return internalError(error, { request, context: "Admin users query failed" });
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
  const verified = await requireAdmin(request, "admin_manage_users");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as { userId?: unknown; roleId?: unknown };
  const { userId, roleId } = body ?? {};

  if (typeof userId !== "string" || typeof roleId !== "string" || !userId || !roleId) {
    return apiError("request.missing_fields", {
      params: { fields: ["userId", "roleId"] },
      request,
    });
  }

  const supabase = getSupabaseServiceClient();

  // TASK-145: the role rules apply before any change — no self-change, no protected role, no
  // granting or removing permissions the admin does not hold.
  // A lookup that cannot be answered stops the change (503) — an unread role would otherwise
  // pass the rules as a role with no permissions (release review, Sprint 7X).
  let target: Awaited<ReturnType<typeof findUser>>;
  let newRole: Awaited<ReturnType<typeof findRole>>;
  let currentRole: Awaited<ReturnType<typeof findRole>> = null;
  try {
    target = await findUser(supabase, userId);
    newRole = await findRole(supabase, { id: roleId });
    if (target?.roleId) currentRole = await findRole(supabase, { id: target.roleId });
  } catch (err) {
    logger.error("Role change lookup failed", {
      route: "api/admin/users",
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError("service.unavailable", { params: { service: "roles" }, request });
  }
  if (!target) {
    return apiError("admin.target_not_found", { params: { target: "user" }, request });
  }
  if (!newRole) {
    return apiError("admin.target_not_found", { params: { target: "role" }, request });
  }
  // A user whose current role cannot be found is not changed: the protected-role rule could
  // not be applied to it.
  if (target.roleId && !currentRole) {
    return apiError("admin.target_not_found", { params: { target: "role" }, request });
  }
  const refused = checkRoleAssignment(admin, target.id, newRole, currentRole);
  if (refused) return apiError(refused.code, { params: refused.params, request });

  return auditedResponse(
    {
      action: "role_changed",
      actorId: admin.userId,
      targetId: target.id,
      details: {
        oldRoleId: currentRole?.id ?? null,
        oldRole: currentRole?.name ?? null,
        newRoleId: newRole.id,
        newRole: newRole.name,
      },
    },
    async () => {
      const { error } = await supabase
        .from("users")
        .update({ role_id: newRole.id })
        .eq("id", target.id);
      if (error) {
        return {
          success: false,
          error: error.message,
          response: internalError(error, {
            request,
            context: "Admin users query failed",
          }),
        };
      }
      if (target.cognitoSub) invalidatePermissions(target.cognitoSub);
      return { success: true, response: NextResponse.json({ success: true }) };
    },
    () => apiError("service.unavailable", { params: { service: "audit" }, request })
  );
}
