/**
 * platform/auth/role-assignment.ts — The one place a user's role is changed (TASK-194, audit C-5)
 *
 * Every production statement that changes users.role_id is here, and applies the role rules
 * (platform/auth/role-governance.ts checkRoleAssignment) to the actor, on the rows the update
 * changes — the user locked, both roles read in the same transaction:
 *
 *   1. no one changes their own role;
 *   2. a protected role (super_admin) is neither assigned nor taken away — it changes in the
 *      database only (ADR-013);
 *   3. the actor holds every permission of the new role and of the current one.
 *
 * Its callers: the Users screen (PATCH /api/admin/users), the command bar's change_user_role, and
 * an operator making a tenant's first administrator (platform/tenancy/admin.ts makeTenantAdmin).
 * Before, the operator path set role_id = 'admin' on the owner connection with no rule at all:
 * one operator could "make admin" another operator's address in its tenant, demoting a super_admin
 * — rule 2 — with no second operator involved. `__tests__/role-writes.test.ts` fails when a
 * statement elsewhere writes users.role_id.
 *
 * The caller chooses the transaction (the tenant's, or an operator's owner transaction for another
 * tenant) and records the change; this only decides and writes.
 *
 * @module platform/auth
 */

import type { Tx } from "@/platform/data";
import {
  checkRoleAssignment,
  type RoleRefusal,
  type VerifiedAdmin,
} from "@/platform/auth/role-governance";
import {
  findRole,
  findUser,
  type RoleWithPermissions,
  type UserRef,
} from "@/platform/auth/role-lookup";
import { sameOptionalId } from "@/platform/auth/same-id";

export type RoleAssignmentOutcome =
  | {
      readonly kind: "changed";
      readonly target: UserRef;
      readonly from: RoleWithPermissions | null;
      readonly to: RoleWithPermissions;
    }
  /** The user, the role, or the user's current role is not there (nothing changed). */
  | { readonly kind: "not_found"; readonly what: "user" | "role" | "current_role" }
  /** A rule refused it (nothing changed). */
  | { readonly kind: "refused"; readonly refusal: RoleRefusal }
  /**
   * The user's role is no longer the one the change was requested against (`expectCurrentRoleId`;
   * TASK-193, audit B-4: a held change applied only onto the role it was held against). Nothing
   * changed.
   */
  | { readonly kind: "stale" };

export interface RoleAssignmentOptions {
  /**
   * The role id (null: none) the user must still have for the change to apply — a held change's
   * snapshot of the user's role when it was requested. Omitted: no such check.
   */
  readonly expectCurrentRoleId?: string | null;
}

/**
 * Move the user `identifier` (an id, or an email only one live account has) to `role`, as
 * `actor`, in `tx` — the user row locked, the rules applied to what the update changes, then
 * (with `options.expectCurrentRoleId`) the user's role compared with the one expected.
 */
export async function assignUserRole(
  tx: Tx,
  actor: VerifiedAdmin,
  identifier: string,
  role: { readonly id: string } | { readonly name: string },
  options: RoleAssignmentOptions = {}
): Promise<RoleAssignmentOutcome> {
  const target = await findUser(tx, identifier, { forUpdate: true });
  if (!target) return { kind: "not_found", what: "user" };
  const to = await findRole(tx, role);
  if (!to) return { kind: "not_found", what: "role" };
  const from = target.roleId ? await findRole(tx, { id: target.roleId }) : null;
  // The protected-role rule cannot be applied to a role that cannot be found: no change.
  if (target.roleId && !from) return { kind: "not_found", what: "current_role" };
  const refused = checkRoleAssignment(actor, target.id, to, from);
  if (refused) return { kind: "refused", refusal: refused };
  if (
    options.expectCurrentRoleId !== undefined &&
    !sameOptionalId(target.roleId ?? null, options.expectCurrentRoleId)
  ) {
    return { kind: "stale" };
  }
  await tx.query("update users set role_id = $2::uuid where id = $1::uuid", [
    target.id,
    to.id,
  ]);
  return { kind: "changed", target, from, to };
}
