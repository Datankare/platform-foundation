/**
 * app/api/admin/ai/handlers/roles.ts — role + permission + user-role action handlers.
 *
 * Each handler applies the role rules (platform/auth/role-governance.ts) first, then records the
 * change and makes it (runAudited): a change whose audit record cannot be written is not made.
 *
 * Roles and their permissions are the platform catalog, shared by every tenant (ADR-053 D5):
 * creating, deleting, duplicating a role and changing its permissions is allowed only when
 * mayChangePlatformCatalog(admin), and runs on the owner connection (catalogTx). Assigning a
 * role to a user is the tenant's own data, in the tenant's transaction. Each change re-reads
 * what its rules were checked against inside the transaction that writes it — locked — and
 * checks them again, so a concurrent change cannot slip between the check and the write.
 */

import { withTenantTx, type Tx } from "@/platform/data";
import {
  clearPermissionsCache,
  invalidatePermissions,
} from "@/platform/auth/permissions-cache";
import {
  checkDefaultRoleGrant,
  checkPermissionGrant,
  checkRoleAssignment,
  checkRoleEditable,
  type VerifiedAdmin,
} from "@/platform/auth/role-governance";
import {
  findRole,
  findUser,
  type RoleWithPermissions,
  type UserRef,
} from "@/platform/auth/role-lookup";
import { mayChangePlatformCatalog } from "@/platform/admin/config-scope";
import { NEW_ROLE_SORT_ORDER } from "@/platform/auth/catalog-order";
import { staleChangeMessage } from "@/platform/admin/stale-change";
import {
  catalogTx,
  failedAsResult,
  operatorOnly,
  refusal,
  runAudited,
  type ActionResult,
} from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The entries of a list input as strings; anything that is not a list is no entries. */
function codes(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** The users holding a role, in every tenant (the owner sees them all): a role in use stays. */
/**
 * A role-catalog write (create, duplicate, delete, permissions added or removed): the catalog is
 * the platform's, read by every tenant, so a change that succeeded clears every cached permission
 * set, here and on every instance (review 7 M5 — before, removing a permission from a role or
 * deleting a role others inherit from left cached grants standing for up to the cache's TTL).
 */
async function catalogWrite(write: () => Promise<ActionResult>): Promise<ActionResult> {
  const result = await failedAsResult(write);
  if (result.success) await clearPermissionsCache();
  return result;
}

async function holdersOf(tx: Tx, roleId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    "select count(*)::int as n from users where role_id = $1::uuid",
    [roleId]
  );
  return rows[0]?.n ?? 0;
}

export async function handleCreateRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const { name, display_name, description, permissions } = input;
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  const granted = codes(permissions);
  const refused = checkRoleEditable(String(name)) ?? checkPermissionGrant(admin, granted);
  if (refused) return refusal(refused);

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: { type: "create_role", prompt_action: true, name, permissions },
    },
    () =>
      catalogWrite(() =>
        // The role and its permissions in one transaction: never a role without them.
        catalogTx(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `insert into roles (name, display_name, description, is_default, sort_order)
             values ($1, $2, $3, false, $4::int)
             returning id`,
            // After the seeded roles, with the rest by name (TASK-192; the column's default too).
            [name ?? null, display_name ?? null, description || "", NEW_ROLE_SORT_ORDER]
          );
          if (granted.length > 0) {
            await tx.query(
              `insert into role_permissions (role_id, permission_id)
               select $1::uuid, p.id from permissions p where p.code = any($2::text[])`,
              [rows[0].id, granted]
            );
          }
          return {
            success: true,
            result: `Role "${display_name}" created with ${permissions?.length || 0} permissions`,
          };
        })
      )
  );
}

/** Why a role cannot be deleted, or null: its rules, then whether anyone still holds it. */
function deletionRefused(
  admin: VerifiedAdmin,
  role: RoleWithPermissions,
  holders: number,
  roleName: unknown
): ActionResult | null {
  const refused =
    checkRoleEditable(role.name) ?? checkPermissionGrant(admin, role.permissions);
  if (refused) return refusal(refused);
  if (holders > 0) {
    return {
      success: false,
      error: `Cannot delete "${roleName}" — ${holders} users assigned. Reassign first.`,
    };
  }
  return null;
}

export async function handleDeleteRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const { role_name } = input;
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();

  const found = await catalogTx(async (tx) => {
    const role = await findRole(tx, { name: String(role_name) });
    return role ? { role, holders: await holdersOf(tx, role.id) } : null;
  });
  if (!found) return { success: false, error: `Role "${role_name}" not found` };
  const refused = deletionRefused(admin, found.role, found.holders, role_name);
  if (refused) return refused;

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: {
        type: "delete_role",
        prompt_action: true,
        role_name,
        permissions: found.role.permissions,
      },
    },
    () =>
      catalogWrite(() =>
        catalogTx(async (tx) => {
          const role = await findRole(tx, { id: found.role.id }, { forUpdate: true });
          if (!role) return { success: false, error: `Role "${role_name}" not found` };
          const now = deletionRefused(
            admin,
            role,
            await holdersOf(tx, role.id),
            role_name
          );
          if (now) return now;
          await tx.query("delete from role_permissions where role_id = $1::uuid", [
            role.id,
          ]);
          await tx.query("delete from roles where id = $1::uuid", [role.id]);
          return { success: true, result: `Role "${role_name}" deleted` };
        })
      )
  );
}

export async function handleDuplicateRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const { source_role, new_name, new_display_name } = input;
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();

  const check = (source: RoleWithPermissions) => {
    // A protected role is not copied: the copy would be its power without its protection.
    const refused =
      checkRoleEditable(source.name) ??
      checkRoleEditable(String(new_name)) ??
      checkPermissionGrant(admin, source.permissions);
    return refused ? refusal(refused) : null;
  };
  const sourceRole = await catalogTx((tx) => findRole(tx, { name: String(source_role) }));
  if (!sourceRole) {
    return { success: false, error: `Source role "${source_role}" not found` };
  }
  const refused = check(sourceRole);
  if (refused) return refused;

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: { type: "duplicate_role", prompt_action: true, source_role, new_name },
    },
    () =>
      catalogWrite(() =>
        catalogTx(async (tx) => {
          // The source is locked, so the permissions copied are the ones just checked.
          const source = await findRole(tx, { id: sourceRole.id }, { forUpdate: true });
          if (!source) {
            return { success: false, error: `Source role "${source_role}" not found` };
          }
          const now = check(source);
          if (now) return now;
          const { rows } = await tx.query<{ id: string }>(
            `insert into roles (name, display_name, description, is_default, sort_order)
             select $1, $2, 'Duplicated from ' || $3 || '. ' || coalesce(s.description, ''),
                    false, $5::int
               from roles s where s.id = $4::uuid
             returning id`,
            [
              new_name ?? null,
              new_display_name ?? null,
              String(source_role),
              source.id,
              NEW_ROLE_SORT_ORDER,
            ]
          );
          const copied = await tx.query(
            `insert into role_permissions (role_id, permission_id)
             select $1::uuid, rp.permission_id from role_permissions rp
              where rp.role_id = $2::uuid`,
            [rows[0].id, source.id]
          );
          return {
            success: true,
            result: `Role "${new_display_name}" created from "${source_role}" with ${copied.rowCount} permissions`,
          };
        })
      )
  );
}

export async function handleAssignPermissions(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const { role_name, add, remove } = input;
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  const adding = codes(add);
  const removing = codes(remove);

  const check = (role: RoleWithPermissions) => {
    const refused =
      checkRoleEditable(role.name) ??
      checkDefaultRoleGrant(role, adding) ??
      checkPermissionGrant(admin, [...adding, ...removing]);
    return refused ? refusal(refused) : null;
  };
  const found = await catalogTx((tx) => findRole(tx, { name: String(role_name) }));
  if (!found) return { success: false, error: `Role "${role_name}" not found` };
  const refused = check(found);
  if (refused) return refused;

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
    () =>
      catalogWrite(() =>
        // Additions and removals together: all of them or none.
        catalogTx(async (tx) => {
          const role = await findRole(tx, { id: found.id }, { forUpdate: true });
          if (!role) return { success: false, error: `Role "${role_name}" not found` };
          const now = check(role);
          if (now) return now;

          let addedCount = 0;
          let removedCount = 0;
          if (adding.length > 0) {
            // Counts each named permission that exists, as before: re-adding one is a no-op.
            const { rows } = await tx.query<{ n: number }>(
              `with p as (select id from permissions where code = any($2::text[])),
                    added as (
                      insert into role_permissions (role_id, permission_id)
                      select $1::uuid, p.id from p
                      on conflict (role_id, permission_id) do nothing
                    )
               select count(*)::int as n from p`,
              [role.id, adding]
            );
            addedCount = rows[0]?.n ?? 0;
          }
          if (removing.length > 0) {
            const { rows } = await tx.query<{ n: number }>(
              `with p as (select id from permissions where code = any($2::text[])),
                    removed as (
                      delete from role_permissions
                       where role_id = $1::uuid and permission_id in (select id from p)
                    )
               select count(*)::int as n from p`,
              [role.id, removing]
            );
            removedCount = rows[0]?.n ?? 0;
          }

          return {
            success: true,
            result: `Role "${role_name}": +${addedCount}, -${removedCount} permissions`,
          };
        })
      )
  );
}

type Assignment =
  | { readonly ok: false; readonly result: ActionResult }
  | {
      readonly ok: true;
      readonly target: UserRef;
      readonly role: RoleWithPermissions;
      readonly currentRole: RoleWithPermissions | null;
    };

/**
 * The user, the role to assign and the user's current role, read in `tx` (the tenant's), with
 * the role rules applied. A read error throws LookupUnavailableError: the change stops.
 */
async function resolveAssignment(
  tx: Tx,
  admin: VerifiedAdmin,
  identifier: string,
  roleName: string,
  lock: boolean
): Promise<Assignment> {
  // Exact lookups on bound parameters — the identifier is never spliced into a filter, where a
  // crafted value could widen the update to other users (TASK-145).
  const target = await findUser(tx, identifier, { forUpdate: lock });
  if (!target) {
    // Never the identifier itself (TASK-193, audit A-2): the result is the run's step, and an
    // address typed here — mistyped, or someone's with no account — would outlive any erasure.
    return {
      ok: false,
      result: { success: false, error: "User not found" },
    };
  }
  const role = await findRole(tx, { name: roleName });
  if (!role) {
    return {
      ok: false,
      result: { success: false, error: `Role "${roleName}" not found` },
    };
  }
  const currentRole = target.roleId ? await findRole(tx, { id: target.roleId }) : null;
  // The protected-role rule cannot be applied to a role that cannot be found: no change.
  if (target.roleId && !currentRole) {
    return {
      ok: false,
      result: { success: false, error: "The user's current role was not found" },
    };
  }
  const refused = checkRoleAssignment(admin, target.id, role, currentRole);
  if (refused) return { ok: false, result: refusal(refused) };
  return { ok: true, target, role, currentRole };
}

/**
 * The input key a held role change records the user's role under when it is requested (TASK-193,
 * audit B-4): its approval applies it only while the user still has that role. Set by the command
 * bar when it holds the change (heldRoleSnapshot), never taken from a caller.
 */
export const HELD_CURRENT_ROLE = "held_current_role_id";

/**
 * The user's role now, by id (null: none), for a change to be held — undefined when the user
 * cannot be found (the run will refuse it). Read in the current tenant. The id, not the name
 * (review round 1, L5): a role renamed, or deleted and another made with its name, is not the
 * role the change was requested against.
 */
export async function heldRoleSnapshot(
  input: Record<string, any>
): Promise<string | null | undefined> {
  const identifier = String(input.user_identifier ?? "");
  return withTenantTx(async (tx) => {
    const user = await findUser(tx, identifier);
    if (!user) return undefined;
    return user.roleId ?? null;
  });
}

export async function handleChangeUserRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const { user_identifier, new_role } = input;
  const identifier = String(user_identifier ?? "");
  const roleName = String(new_role ?? "");

  // A user of this tenant only: another tenant's users are not visible here (ADR-053 D5).
  const plan = await withTenantTx((tx) =>
    resolveAssignment(tx, admin, identifier, roleName, false)
  );
  if (!plan.ok) return plan.result;

  return runAudited(
    {
      action: "role_changed",
      actorId: admin.userId,
      targetId: plan.target.id,
      details: {
        prompt_action: true,
        oldRole: plan.currentRole?.name ?? null,
        newRole: plan.role.name,
      },
    },
    async () => {
      const outcome = await failedAsResult(() =>
        withTenantTx(async (tx) => {
          // The user is locked and the rules checked again on what the update will change.
          const now = await resolveAssignment(tx, admin, plan.target.id, roleName, true);
          if (!now.ok) return now.result;
          // A held change runs only onto the role it was requested against (TASK-193, audit B-4):
          // the user's role changed since — a year-old approval, or another change made in
          // between — makes it stale, never applied over what is there now.
          if (
            Object.prototype.hasOwnProperty.call(input, HELD_CURRENT_ROLE) &&
            (now.currentRole?.id ?? null) !== input[HELD_CURRENT_ROLE]
          ) {
            return { success: false, error: staleChangeMessage("the user's role") };
          }
          await tx.query("update users set role_id = $2::uuid where id = $1::uuid", [
            now.target.id,
            now.role.id,
          ]);
          // The account's id, never the identifier typed (TASK-193, audit A-2: an address in the
          // step outlived the account's erasure — only a whole-string address is replaced).
          return {
            success: true,
            result: `User ${now.target.id} assigned to "${now.role.name}"`,
          };
        })
      );
      // Also when the commit's outcome is unknown (review 14 L-2): the role may have changed,
      // and an invalidation is harmless if it did not.
      if ((outcome.success || outcome.indeterminate) && plan.target.cognitoSub) {
        await invalidatePermissions(plan.target.cognitoSub);
      }
      return outcome;
    }
  );
}
