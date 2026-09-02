/**
 * app/api/admin/ai/handlers/roles.ts — role + permission + user-role action handlers.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import type { ActionResult } from "./shared";

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
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role_id", role.id);

  if ((count || 0) > 0) {
    return {
      success: false,
      error: `Cannot delete "${role_name}" — ${count} users assigned. Reassign first.`,
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

export async function handleChangeUserRole(
  input: Record<string, any>,
  actorId: string
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { user_identifier, new_role } = input;

  const { data: role } = await supabase
    .from("roles")
    .select("id")
    .eq("name", new_role)
    .single();

  if (!role) return { success: false, error: `Role "${new_role}" not found` };

  const { error } = await supabase
    .from("users")
    .update({ role_id: role.id })
    .or(`email.eq.${user_identifier},id.eq.${user_identifier}`);

  if (error) return { success: false, error: error.message };

  invalidatePermissions(user_identifier);

  await writeAuditLog({
    action: "role_changed",
    actorId,
    details: { prompt_action: true, user_identifier, new_role },
  });

  return {
    success: true,
    result: `User "${user_identifier}" assigned to "${new_role}"`,
  };
}
