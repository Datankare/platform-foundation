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
  holds,
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
import { assignUserRole } from "@/platform/auth/role-assignment";
import {
  FEATURE_PERMISSION_CODES,
  missingFeaturePermissions,
} from "@/platform/auth/feature-permissions";
import {
  applyRule,
  catalogTx,
  coded,
  failedAsResult,
  NO_FACTS,
  operatorOnly,
  refusal,
  runAudited,
  type ActionResult,
  type ApproverRule,
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

/**
 * The role rules for each change, as the change applies them to its requester — and as an
 * approver of the change held for them must satisfy too (TASK-194, audit C-2: an approver needed
 * only the action's page permission, so an admin could approve a role change they could not make
 * themselves). Each returns the coded refusal, or null. They read the catalog as the change
 * would; a read error throws (the caller fails closed).
 */
/**
 * The permissions a new role is created with (TASK-194 round 1, A7): those asked for and, by
 * default, every feature permission — unless `without_feature_permissions` names it. A role made
 * after migration 061 would otherwise lack them, and its holders could not translate or see their
 * profile. A default the creating admin does not hold is left out, not refused (round 2): the
 * grant rule stands — no one grants what they lack — and the role is still created, the result
 * saying which it lacks. Asked for by name, a permission the admin lacks is refused as before.
 */
export function createdRolePermissions(
  input: Record<string, any>,
  admin: VerifiedAdmin
): string[] {
  const without = new Set(codes(input.without_feature_permissions));
  return [
    ...new Set([
      ...codes(input.permissions),
      ...FEATURE_PERMISSION_CODES.filter(
        (code) => !without.has(code) && holds(admin, code)
      ),
    ]),
  ];
}

/** The note a result carries when a role lacks a feature permission (A7), or "". */
function featureGapNote(held: readonly string[]): string {
  const missing = missingFeaturePermissions(held);
  return missing.length
    ? ` Note: the role lacks ${missing.join(", ")} — its holders cannot use those features.`
    : "";
}

function decideCreateRole(
  input: Record<string, any>,
  _facts: null,
  admin: VerifiedAdmin
): ActionResult | null {
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  // The grant rule applies to every permission the role is created with; a default the admin
  // lacks is not among them (round 2), so it is skipped, never a refusal.
  const refused =
    checkRoleEditable(String(input.name)) ??
    checkPermissionGrant(admin, createdRolePermissions(input, admin));
  return refused ? refusal(refused) : null;
}

export const createRoleRule: ApproverRule<null> = {
  facts: NO_FACTS,
  decide: decideCreateRole,
};

export function checkCreateRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return applyRule(createRoleRule, input, admin);
}

/** A role named in the input, as the change would read it (null: none). */
function roleNamed(key: string) {
  return (input: Record<string, any>): Promise<RoleWithPermissions | null> =>
    catalogTx((tx) => findRole(tx, { name: String(input[key]) }));
}

function decideDeleteRole(
  _input: Record<string, any>,
  role: RoleWithPermissions | null,
  admin: VerifiedAdmin
): ActionResult | null {
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  if (!role) return null; // nothing to rule on: the change itself reports it missing
  return deleteRulesRefused(admin, role);
}

export const deleteRoleRule: ApproverRule<RoleWithPermissions | null> = {
  facts: roleNamed("role_name"),
  decide: decideDeleteRole,
};

export function checkDeleteRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return applyRule(deleteRoleRule, input, admin);
}

/** The role rules a deletion is checked against (its holders aside). */
function deleteRulesRefused(
  admin: VerifiedAdmin,
  role: RoleWithPermissions
): ActionResult | null {
  const refused =
    checkRoleEditable(role.name) ?? checkPermissionGrant(admin, role.permissions);
  return refused ? refusal(refused) : null;
}

/** The rules a duplicate is checked against, for a source role already read. */
function duplicateRefused(
  admin: VerifiedAdmin,
  source: RoleWithPermissions,
  newName: unknown
): ActionResult | null {
  // A protected role is not copied: the copy would be its power without its protection.
  const refused =
    checkRoleEditable(source.name) ??
    checkRoleEditable(String(newName)) ??
    checkPermissionGrant(admin, source.permissions);
  return refused ? refusal(refused) : null;
}

function decideDuplicateRole(
  input: Record<string, any>,
  source: RoleWithPermissions | null,
  admin: VerifiedAdmin
): ActionResult | null {
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  return source ? duplicateRefused(admin, source, input.new_name) : null;
}

export const duplicateRoleRule: ApproverRule<RoleWithPermissions | null> = {
  facts: roleNamed("source_role"),
  decide: decideDuplicateRole,
};

export function checkDuplicateRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return applyRule(duplicateRoleRule, input, admin);
}

/** The rules a permission change is checked against, for a role already read. */
function assignmentRefused(
  admin: VerifiedAdmin,
  role: RoleWithPermissions,
  adding: readonly string[],
  removing: readonly string[]
): ActionResult | null {
  const refused =
    checkRoleEditable(role.name) ??
    checkDefaultRoleGrant(role, adding) ??
    checkPermissionGrant(admin, [...adding, ...removing]);
  return refused ? refusal(refused) : null;
}

function decideAssignPermissions(
  input: Record<string, any>,
  role: RoleWithPermissions | null,
  admin: VerifiedAdmin
): ActionResult | null {
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  return role
    ? assignmentRefused(admin, role, codes(input.add), codes(input.remove))
    : null;
}

export const assignPermissionsRule: ApproverRule<RoleWithPermissions | null> = {
  facts: roleNamed("role_name"),
  decide: decideAssignPermissions,
};

export function checkAssignPermissions(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return applyRule(assignPermissionsRule, input, admin);
}

function decideChangeUserRole(
  _input: Record<string, any>,
  facts: AssignmentFacts,
  admin: VerifiedAdmin
): ActionResult | null {
  // Only a rule's refusal is the rules' answer; a user or role not found
  // (admin.target_not_found) is the change's own — its run reports it.
  if (!facts.ok) return null;
  const refused = checkRoleAssignment(
    admin,
    facts.target.id,
    facts.role,
    facts.currentRole
  );
  return refused ? refusal(refused) : null;
}

export const changeUserRoleRule: ApproverRule<AssignmentFacts> = {
  facts: (input) =>
    withTenantTx((tx) =>
      loadAssignment(
        tx,
        String(input.user_identifier ?? ""),
        String(input.new_role ?? ""),
        false
      )
    ),
  decide: decideChangeUserRole,
};

export function checkChangeUserRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return applyRule(changeUserRoleRule, input, admin);
}

export async function handleCreateRole(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const { name, display_name, description } = input;
  const refused = await checkCreateRole(input, admin);
  if (refused) return refused;
  const granted = createdRolePermissions(input, admin);

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: { type: "create_role", prompt_action: true, name, permissions: granted },
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
          let held: string[] = [];
          if (granted.length > 0) {
            const inserted = await tx.query<{ code: string }>(
              `with p as (select id, code from permissions where code = any($2::text[])),
                    granted as (
                      insert into role_permissions (role_id, permission_id)
                      select $1::uuid, p.id from p
                    )
               select code from p`,
              [rows[0].id, granted]
            );
            held = inserted.rows.map((r) => r.code);
          }
          return {
            success: true,
            result: `Role "${display_name}" created with ${held.length} permissions.${featureGapNote(held)}`,
          };
        })
      )
  );
}

/** Why a role cannot be deleted, or null: its rules, then whether anyone still holds it. */
function deletionRefused(
  admin: VerifiedAdmin,
  role: RoleWithPermissions,
  holders: number
): ActionResult | null {
  const refused = deleteRulesRefused(admin, role);
  if (refused) return refused;
  if (holders > 0) {
    return coded("admin.role_in_use", { count: holders });
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
  if (!found) return coded("admin.target_not_found", { target: "role" });
  const refused = deletionRefused(admin, found.role, found.holders);
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
          if (!role) return coded("admin.target_not_found", { target: "role" });
          const now = deletionRefused(admin, role, await holdersOf(tx, role.id));
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

  const check = (source: RoleWithPermissions) =>
    duplicateRefused(admin, source, new_name);
  const sourceRole = await catalogTx((tx) => findRole(tx, { name: String(source_role) }));
  if (!sourceRole) {
    return coded("admin.target_not_found", { target: "source role" });
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
            return coded("admin.target_not_found", { target: "source role" });
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

  const check = (role: RoleWithPermissions) =>
    assignmentRefused(admin, role, adding, removing);
  const found = await catalogTx((tx) => findRole(tx, { name: String(role_name) }));
  if (!found) return coded("admin.target_not_found", { target: "role" });
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
          if (!role) return coded("admin.target_not_found", { target: "role" });
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

          // What the role holds now: a feature permission it lost is said (A7).
          const after = await findRole(tx, { id: role.id });
          return {
            success: true,
            result: `Role "${role_name}": +${addedCount}, -${removedCount} permissions.${featureGapNote(after?.permissions ?? [])}`,
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

/** What a role change reads (no admin in it): the account, the role asked for, its role now. */
type AssignmentFacts = Assignment;

async function loadAssignment(
  tx: Tx,
  identifier: string,
  roleName: string,
  lock: boolean
): Promise<AssignmentFacts> {
  // Exact lookups on bound parameters — the identifier is never spliced into a filter, where a
  // crafted value could widen the update to other users (TASK-145).
  const target = await findUser(tx, identifier, { forUpdate: lock });
  if (!target) {
    // Never the identifier itself (TASK-193, audit A-2): the result is the run's step, and an
    // address typed here — mistyped, or someone's with no account — would outlive any erasure.
    return {
      ok: false,
      result: coded("admin.target_not_found", { target: "user" }),
    };
  }
  const role = await findRole(tx, { name: roleName });
  if (!role) {
    return {
      ok: false,
      result: coded("admin.target_not_found", { target: "role" }),
    };
  }
  const currentRole = target.roleId ? await findRole(tx, { id: target.roleId }) : null;
  // The protected-role rule cannot be applied to a role that cannot be found: no change.
  if (target.roleId && !currentRole) {
    return {
      ok: false,
      result: coded("admin.target_not_found", { target: "current role" }),
    };
  }
  return { ok: true, target, role, currentRole };
}

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
  const facts = await loadAssignment(tx, identifier, roleName, lock);
  if (!facts.ok) return facts;
  const refused = checkRoleAssignment(
    admin,
    facts.target.id,
    facts.role,
    facts.currentRole
  );
  if (refused) return { ok: false, result: refusal(refused) };
  return facts;
}

/**
 * The input key a held role change records the user's role under when it is requested (TASK-193,
 * audit B-4): its approval applies it only while the user still has that role. Set by the command
 * bar when it holds the change (heldRoleSnapshot), never taken from a caller.
 */
export const HELD_CURRENT_ROLE = "held_current_role_id";

/**
 * The account a role change names and its role now (null: none), for the change to be held —
 * undefined when no account is found (the change is then refused, never held). Read in the
 * current tenant. The role by id, not name (review round 1, L5): a role renamed, or deleted and
 * another made with its name, is not the role the change was requested against. The account by
 * id (rebase P-1): the hold records the account itself, never the address typed — an address
 * that outlives the account's erasure, and that a new account may register again.
 */
export async function heldRoleSnapshot(
  input: Record<string, any>
): Promise<{ readonly userId: string; readonly roleId: string | null } | undefined> {
  const identifier = String(input.user_identifier ?? "");
  return withTenantTx(async (tx) => {
    const user = await findUser(tx, identifier);
    if (!user) return undefined;
    return { userId: user.id, roleId: user.roleId ?? null };
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
          // The user is locked and the rules checked again on what the update will change —
          // by the one role writer (platform/auth/role-assignment.ts, audit C-5). A held change
          // runs only onto the role it was requested against (TASK-193, audit B-4): the user's
          // role changed since — a year-old approval, or another change made in between — makes
          // it stale, never applied over what is there now.
          const now = await assignUserRole(
            tx,
            admin,
            plan.target.id,
            { name: roleName },
            Object.prototype.hasOwnProperty.call(input, HELD_CURRENT_ROLE)
              ? { expectCurrentRoleId: input[HELD_CURRENT_ROLE] ?? null }
              : {}
          );
          if (now.kind === "refused") return refusal(now.refusal);
          if (now.kind === "stale") {
            // Stale (approvals.stale): its decision withdraws it when the withdrawal lands; asked
            // again against now.
            return coded("approvals.stale");
          }
          if (now.kind === "not_found") {
            // Never the identifier itself (TASK-193, audit A-2).
            return coded("admin.target_not_found", {
              target:
                now.what === "user"
                  ? "user"
                  : now.what === "role"
                    ? "role"
                    : "current role",
            });
          }
          // Never the identifier typed (TASK-193, audit A-2: an address in the step outlived the
          // account's erasure), nor the account's id (TASK-202, N-63: a person reads an address):
          // the screen names the account by its address (ActionResult.account, added by the
          // execute route for the screen only); the step keeps the id in its input.
          return {
            success: true,
            result: `Role changed to "${now.to.name}"`,
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
