/**
 * app/api/admin/entitlements/route.ts — Admin entitlement management
 *
 * GET: List entitlement groups with player counts
 * PATCH: Toggle active status
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Get player counts per group
  const { data: assignments } = await supabase
    .from("player_entitlements")
    .select("entitlement_group_id")
    .is("revoked_at", null);

  const playerCounts = new Map<string, number>();
  for (const a of assignments || []) {
    const gid = a.entitlement_group_id as string;
    playerCounts.set(gid, (playerCounts.get(gid) || 0) + 1);
  }

  const result = (groups || []).map(
    (g: { id: string; code: string; display_name: string; is_active: boolean }) => ({
      id: g.id,
      code: g.code,
      displayName: g.display_name,
      isActive: g.is_active,
      playerCount: playerCounts.get(g.id) || 0,
    })
  );

  return NextResponse.json({ groups: result });
}

export async function PATCH(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_entitlements");
  if (denied) return denied;

  const body = await request.json();
  const { groupId, isActive } = body;

  if (!groupId || typeof isActive !== "boolean") {
    return NextResponse.json({ error: "groupId and isActive required" }, { status: 400 });
  }

  const supabase = getSupabaseServiceClient();

  const { error } = await supabase
    .from("entitlement_groups")
    .update({ is_active: isActive })
    .eq("id", groupId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await writeAuditLog({
    action: "admin_action",
    actorId: "dev-admin",
    details: {
      type: "entitlement_toggle",
      groupId,
      isActive,
    },
  });

  return NextResponse.json({ success: true });
}
