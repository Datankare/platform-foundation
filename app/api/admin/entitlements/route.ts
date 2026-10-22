/**
 * app/api/admin/entitlements/route.ts — Admin entitlement management
 *
 * GET: List entitlement groups with user counts
 * PATCH: Turn a group on or off — refused unless the admin holds every permission it grants
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { checkPermissionGrant } from "@/platform/auth/role-governance";
import { clearPermissionsCache } from "@/platform/auth/permissions-cache";
import { auditedResponse } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import { apiError, internalError, readJsonObject } from "@/platform/errors";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_entitlements");
  if (denied) return denied;

  const supabase = getSupabaseServiceClient();

  const { data: groups, error } = await supabase
    .from("entitlement_groups")
    .select("id, code, display_name, is_active")
    .order("code");

  if (error) {
    logger.error("Admin entitlements list failed", {
      error: error.message,
      route: "api/admin/entitlements",
    });
    return internalError(error, { request, context: "Admin entitlements query failed" });
  }

  // Get user counts per group
  const { data: assignments } = await supabase
    .from("user_entitlements")
    .select("entitlement_group_id")
    .is("revoked_at", null);

  const userCounts = new Map<string, number>();
  for (const a of assignments || []) {
    const gid = a.entitlement_group_id as string;
    userCounts.set(gid, (userCounts.get(gid) || 0) + 1);
  }

  const result = (groups || []).map(
    (g: { id: string; code: string; display_name: string; is_active: boolean }) => ({
      id: g.id,
      code: g.code,
      displayName: g.display_name,
      isActive: g.is_active,
      userCount: userCounts.get(g.id) || 0,
    })
  );

  return NextResponse.json({ groups: result });
}

export async function PATCH(request: NextRequest) {
  const verified = await requireAdmin(request, "admin_manage_entitlements");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as { groupId?: unknown; isActive?: unknown };
  const { groupId, isActive } = body ?? {};

  if (typeof groupId !== "string" || !groupId || typeof isActive !== "boolean") {
    return apiError("request.missing_fields", {
      params: { fields: ["groupId", "isActive"] },
      request,
    });
  }

  const supabase = getSupabaseServiceClient();

  // An active group grants its permissions to everyone who holds it, so turning one on or off
  // is granting or removing those permissions (TASK-145): the admin must hold every one.
  const { data: group } = await supabase
    .from("entitlement_groups")
    .select("id, code")
    .eq("id", groupId)
    .maybeSingle();
  if (!group) {
    return apiError("admin.target_not_found", {
      params: { target: "entitlement" },
      request,
    });
  }
  // An unread permission list is not an empty one: it stops the change (release review).
  const { data: links, error: linkError } = await supabase
    .from("entitlement_permissions")
    .select("permission_id")
    .eq("entitlement_group_id", group.id);
  const ids = (links ?? []).map((l: { permission_id: string }) => l.permission_id);
  const { data: perms, error: permError } = ids.length
    ? await supabase.from("permissions").select("code").in("id", ids)
    : { data: [] as { code: string }[], error: null };
  if (linkError || permError) {
    logger.error("Entitlement group permissions unreadable", {
      route: "api/admin/entitlements",
      error: (linkError ?? permError)?.message,
    });
    return apiError("service.unavailable", {
      params: { service: "entitlements" },
      request,
    });
  }
  const refused = checkPermissionGrant(
    admin,
    (perms ?? []).map((p: { code: string }) => p.code)
  );
  if (refused) return apiError(refused.code, { params: refused.params, request });

  return auditedResponse(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: {
        type: "entitlement_toggle",
        groupId: group.id,
        code: group.code,
        isActive,
      },
    },
    async () => {
      const { error } = await supabase
        .from("entitlement_groups")
        .update({ is_active: isActive })
        .eq("id", group.id);
      if (error) {
        return {
          success: false,
          error: error.message,
          response: internalError(error, {
            request,
            context: "Admin entitlements query failed",
          }),
        };
      }
      // Holders' cached permissions change with the group.
      clearPermissionsCache();
      return { success: true, response: NextResponse.json({ success: true }) };
    },
    () => apiError("service.unavailable", { params: { service: "audit" }, request })
  );
}
