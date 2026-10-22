/**
 * app/api/admin/ai/handlers/roles.ts — role + permission + user-role action handlers.
 *
 * Each handler applies the role rules (platform/auth/role-governance.ts) first, then records the
 * change and makes it (runAudited): a change whose audit record cannot be written is not made.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import {
  checkPermissionGrant,
  checkRoleAssignment,
  checkRoleEditable,
  type VerifiedAdmin,
} from "@/platform/auth/role-governance";
import { findRole, findUser } from "@/platform/auth/role-lookup";
import { refusal, runAudited, type ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function handleCreateRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { name, display_name, description, permissions } = input;
  const refused =
    checkRoleEditable(String(name)) ??
    checkPermissionGrant(admin, Array.isArray(permissions) ? permissions : []);
  if (refused) return refusal(refused);

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: { type: "create_role", prompt_action: true, name, permissions },
    },
    async () => {
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

      return {
        success: true,
        result: `Role "${display_name}" created with ${permissions?.length || 0} permissions`,
      };
    }
  );
}

export async function handleDeleteRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { role_name } = input;

  const role = await findRole(supabase, { name: String(role_name) });
  if (!role) return { success: false, error: `Role "${role_name}" not found` };
  const refused =
    checkRoleEditable(role.name) ?? checkPermissionGrant(admin, role.permissions);
  if (refused) return refusal(refused);

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

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: {
        type: "delete_role",
        prompt_action: true,
        role_name,
        permissions: role.permissions,
      },
    },
    async () => {
      await supabase.from("role_permissions").delete().eq("role_id", role.id);
      const { error } = await supabase.from("roles").delete().eq("id", role.id);
      if (error) return { success: false, error: error.message };
      return { success: true, result: `Role "${role_name}" deleted` };
    }
  );
}

export async function handleDuplicateRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { source_role, new_name, new_display_name } = input;

  const { data: source } = await supabase
    .from("roles")
    .select("id, description")
    .eq("name", source_role)
    .single();

  if (!source) return { success: false, error: `Source role "${source_role}" not found` };
  const sourceRole = await findRole(supabase, { name: String(source_role) });
  const refused =
    checkRoleEditable(String(new_name)) ??
    checkPermissionGrant(admin, sourceRole?.permissions ?? []);
  if (refused) return refusal(refused);

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: { type: "duplicate_role", prompt_action: true, source_role, new_name },
    },
    async () => {
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

      return {
        success: true,
        result: `Role "${new_display_name}" created from "${source_role}" with ${sourcePerms?.length || 0} permissions`,
      };
    }
  );
}

export async function handleAssignPermissions(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { role_name, add, remove } = input;

  const role = await findRole(supabase, { name: String(role_name) });
  if (!role) return { success: false, error: `Role "${role_name}" not found` };
  const refused =
    checkRoleEditable(role.name) ??
    checkPermissionGrant(admin, [
      ...(Array.isArray(add) ? add : []),
      ...(Array.isArray(remove) ? remove : []),
    ]);
  if (refused) return refusal(refused);

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: {
        type: "assign_permissions",
        prompt_action: true,
        role_name,
        added: add,
        removed: remove,
      },
    },
    async () => {
      let addedCount = 0;
      let removedCount = 0;

      if (add?.length > 0) {
        const { data: perms } = await supabase
          .from("permissions")
          .select("id")
          .in("code", add);
        for (const p of perms ?? []) {
          await supabase
            .from("role_permissions")
            .upsert(
              { role_id: role.id, permission_id: p.id },
              { onConflict: "role_id,permission_id" }
            );
          addedCount++;
        }
      }

      if (remove?.length > 0) {
        const { data: perms } = await supabase
          .from("permissions")
          .select("id")
          .in("code", remove);
        for (const p of perms ?? []) {
          await supabase
            .from("role_permissions")
            .delete()
            .eq("role_id", role.id)
            .eq("permission_id", p.id);
          removedCount++;
        }
      }

      return {
        success: true,
        result: `Role "${role_name}": +${addedCount}, -${removedCount} permissions`,
      };
    }
  );
}

export async function handleChangeUserRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { user_identifier, new_role } = input;

  // Exact lookups through bound filters — the identifier is never spliced into a filter string,
  // where a crafted value could widen the update to other users (TASK-145).
  const target = await findUser(supabase, String(user_identifier ?? ""));
  if (!target) return { success: false, error: `User "${user_identifier}" not found` };
  const role = await findRole(supabase, { name: String(new_role ?? "") });
  if (!role) return { success: false, error: `Role "${new_role}" not found` };
  const currentRole = target.roleId
    ? await findRole(supabase, { id: target.roleId })
    : null;
  // The protected-role rule cannot be applied to a role that cannot be found: no change.
  if (target.roleId && !currentRole) {
    return { success: false, error: "The user's current role was not found" };
  }
  const refused = checkRoleAssignment(admin, target.id, role, currentRole);
  if (refused) return refusal(refused);

  return runAudited(
    {
      action: "role_changed",
      actorId: admin.userId,
      targetId: target.id,
      details: {
        prompt_action: true,
        oldRole: currentRole?.name ?? null,
        newRole: role.name,
      },
    },
    async () => {
      const { error } = await supabase
        .from("users")
        .update({ role_id: role.id })
        .eq("id", target.id);

      if (error) return { success: false, error: error.message };

      if (target.cognitoSub) invalidatePermissions(target.cognitoSub);

      return {
        success: true,
        result: `User "${user_identifier}" assigned to "${role.name}"`,
      };
    }
  );
}
