/**
 * app/api/admin/ai/handlers/entitlements.ts — entitlement action handlers.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import type { ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function handleCreateEntitlementGroup(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { code, display_name, permissions } = input;

  const { data: group, error } = await supabase
    .from("entitlement_groups")
    .insert({ code, display_name, is_active: true })
    .select("id")
    .single();

  if (error) return { success: false, error: error.message };

  if (permissions?.length > 0 && group) {
    const { data: perms } = await supabase
      .from("permissions")
      .select("id")
      .in("code", permissions);
    if (perms) {
      const inserts = perms.map((p: { id: string }) => ({
        entitlement_group_id: group.id,
        permission_id: p.id,
      }));
      await supabase.from("entitlement_permissions").insert(inserts);
    }
  }

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "create_entitlement_group", prompt_action: true, code, permissions },
  });

  return { success: true, result: `Entitlement "${display_name}" created` };
}
