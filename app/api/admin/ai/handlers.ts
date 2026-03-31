/**
 * app/api/admin/ai/handlers.ts — Individual action handlers
 *
 * Each tool from the AI orchestrator has a dedicated handler.
 * Extracted from execute/route.ts for SRP compliance.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";

type ActionResult = {
  success: boolean;
  result?: string;
  error?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function handleCreateRole(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { name, display_name, description, permissions } = input;

  const { data: role, error } = await supabase
    .from("roles")
    .insert({
      name,
      display_name,
      description: description || "",
      is_default: false,
      sort_order: 99,
    })
    .select("id")
    .single();

  if (error) return { success: false, error: error.message };

  if (permissions?.length > 0 && role) {
    const { data: perms } = await supabase
      .from("permissions")
      .select("id, code")
      .in("code", permissions);

    if (perms && perms.length > 0) {
      const rolePerms = perms.map((p: { id: string }) => ({
        role_id: role.id,
        permission_id: p.id,
      }));
      await supabase.from("role_permissions").insert(rolePerms);
    }
  }

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "create_role", prompt_action: true, name, permissions },
  });

  return {
    success: true,
    result: `Role "${display_name}" created with ${permissions?.length || 0} permissions`,
  };
}

export async function handleDeleteRole(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { role_name } = input;

  const { data: role } = await supabase
    .from("roles")
    .select("id")
    .eq("name", role_name)
    .single();

  if (!role) return { success: false, error: `Role "${role_name}" not found` };

  const { count } = await supabase
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("role_id", role.id);

  if ((count || 0) > 0) {
    return {
      success: false,
      error: `Cannot delete "${role_name}" — ${count} players assigned. Reassign first.`,
    };
  }

  await supabase.from("role_permissions").delete().eq("role_id", role.id);
  await supabase.from("roles").delete().eq("id", role.id);

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "delete_role", prompt_action: true, role_name },
  });

  return { success: true, result: `Role "${role_name}" deleted` };
}

export async function handleDuplicateRole(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { source_role, new_name, new_display_name } = input;

  const { data: source } = await supabase
    .from("roles")
    .select("id, description")
    .eq("name", source_role)
    .single();

  if (!source) return { success: false, error: `Source role "${source_role}" not found` };

  const { data: newRole, error } = await supabase
    .from("roles")
    .insert({
      name: new_name,
      display_name: new_display_name,
      description: `Duplicated from ${source_role}. ${source.description || ""}`,
      is_default: false,
      sort_order: 99,
    })
    .select("id")
    .single();

  if (error) return { success: false, error: error.message };

  const { data: sourcePerms } = await supabase
    .from("role_permissions")
    .select("permission_id")
    .eq("role_id", source.id);

  if (sourcePerms && sourcePerms.length > 0 && newRole) {
    const newPerms = sourcePerms.map((p: { permission_id: string }) => ({
      role_id: newRole.id,
      permission_id: p.permission_id,
    }));
    await supabase.from("role_permissions").insert(newPerms);
  }

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "duplicate_role", prompt_action: true, source_role, new_name },
  });

  return {
    success: true,
    result: `Role "${new_display_name}" created from "${source_role}" with ${sourcePerms?.length || 0} permissions`,
  };
}

export async function handleAssignPermissions(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { role_name, add, remove } = input;

  const { data: role } = await supabase
    .from("roles")
    .select("id")
    .eq("name", role_name)
    .single();

  if (!role) return { success: false, error: `Role "${role_name}" not found` };

  let addedCount = 0;
  let removedCount = 0;

  if (add?.length > 0) {
    const { data: perms } = await supabase
      .from("permissions")
      .select("id")
      .in("code", add);
    if (perms) {
      for (const p of perms) {
        await supabase
          .from("role_permissions")
          .upsert(
            { role_id: role.id, permission_id: p.id },
            { onConflict: "role_id,permission_id" }
          );
        addedCount++;
      }
    }
  }

  if (remove?.length > 0) {
    const { data: perms } = await supabase
      .from("permissions")
      .select("id")
      .in("code", remove);
    if (perms) {
      for (const p of perms) {
        await supabase
          .from("role_permissions")
          .delete()
          .eq("role_id", role.id)
          .eq("permission_id", p.id);
        removedCount++;
      }
    }
  }

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: {
      type: "assign_permissions",
      prompt_action: true,
      role_name,
      added: add,
      removed: remove,
    },
  });

  return {
    success: true,
    result: `Role "${role_name}": +${addedCount}, -${removedCount} permissions`,
  };
}

export async function handleChangePlayerRole(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { player_identifier, new_role } = input;

  const { data: role } = await supabase
    .from("roles")
    .select("id")
    .eq("name", new_role)
    .single();

  if (!role) return { success: false, error: `Role "${new_role}" not found` };

  const { error } = await supabase
    .from("players")
    .update({ role_id: role.id })
    .or(`email.eq.${player_identifier},id.eq.${player_identifier}`);

  if (error) return { success: false, error: error.message };

  invalidatePermissions(player_identifier);

  await writeAuditLog({
    action: "role_changed",
    actorId,
    details: { prompt_action: true, player_identifier, new_role },
  });

  return {
    success: true,
    result: `Player "${player_identifier}" assigned to "${new_role}"`,
  };
}

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

export async function handleUpdateGuestConfig(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();

  await supabase.from("guest_config").update({ is_active: false }).eq("is_active", true);

  const { error } = await supabase.from("guest_config").insert({
    nudge_after_sessions: input.nudge_after_sessions,
    grace_after_sessions: input.grace_after_sessions,
    lockout_after_sessions: input.lockout_after_sessions,
    guest_token_ttl_hours: input.guest_token_ttl_hours,
    is_active: true,
  });

  if (error) return { success: false, error: error.message };

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "update_guest_config", prompt_action: true, ...input },
  });

  return { success: true, result: "Guest configuration updated" };
}

export async function handleUpdatePasswordPolicy(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase.from("password_policy").upsert(
    {
      role_id: null,
      player_id: null,
      min_length: input.min_length,
      rotation_days: input.rotation_days,
      require_uppercase: input.require_uppercase,
      require_lowercase: input.require_lowercase,
      require_number: input.require_number,
      require_special: input.require_special,
      password_history_count: input.password_history_count,
    },
    { onConflict: "role_id,player_id" }
  );

  if (error) return { success: false, error: error.message };

  await writeAuditLog({
    action: "admin_action",
    actorId,
    details: { type: "update_password_policy", prompt_action: true },
  });

  return { success: true, result: "Password policy updated" };
}

export async function handleSearch(input: Record<string, any>): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { table } = input;

  const { data: searchData, error } = await supabase.from(table).select("*").limit(20);

  if (error) return { success: false, error: error.message };
  return {
    success: true,
    result: JSON.stringify(searchData || [], null, 2),
  };
}
