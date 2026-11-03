/**
 * app/api/admin/ai/handlers/entitlements.ts — entitlement action handlers.
 *
 * Entitlement groups and their permissions are the platform catalog, shared by every tenant
 * (ADR-053 D5): creating one is allowed only when mayChangePlatformCatalog(admin), and runs on
 * the owner connection — the group and its permissions in one transaction.
 */

import {
  checkPermissionGrant,
  type VerifiedAdmin,
} from "@/platform/auth/role-governance";
import { mayChangePlatformCatalog } from "@/platform/admin/config-scope";
import { clearPermissionsCache } from "@/platform/auth/permissions-cache";
import type { Tx } from "@/platform/data";
import {
  applyRule,
  catalogTx,
  coded,
  failedAsResult,
  NO_FACTS,
  type ApproverRule,
  operatorOnly,
  refusal,
  runAudited,
  type ActionResult,
} from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The rules each entitlement change applies to its requester, and an approver of the change held
 * for them must satisfy too (TASK-194, audit C-2). The coded refusal, or null; read errors throw.
 */
function decideCreateEntitlementGroup(
  input: Record<string, any>,
  _facts: null,
  admin: VerifiedAdmin
): ActionResult | null {
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  const granted = Array.isArray(input.permissions) ? input.permissions.map(String) : [];
  // An entitlement grants its permissions to whoever holds it (TASK-145).
  const refused = checkPermissionGrant(admin, granted);
  return refused ? refusal(refused) : null;
}

export const createEntitlementGroupRule: ApproverRule<null> = {
  facts: NO_FACTS,
  decide: decideCreateEntitlementGroup,
};

export function checkCreateEntitlementGroup(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return applyRule(createEntitlementGroupRule, input, admin);
}

type GroupFacts = Awaited<ReturnType<typeof groupWithPermissions>>;

function decideSetEntitlementGroupActive(
  _input: Record<string, any>,
  group: GroupFacts,
  admin: VerifiedAdmin
): ActionResult | null {
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  if (!group) return null; // the change itself reports it missing
  const refused = checkPermissionGrant(admin, group.permissions);
  return refused ? refusal(refused) : null;
}

export const setEntitlementGroupActiveRule: ApproverRule<GroupFacts> = {
  facts: (input) =>
    catalogTx((tx) => groupWithPermissions(tx, String(input.group_id ?? ""), false)),
  decide: decideSetEntitlementGroupActive,
};

export function checkSetEntitlementGroupActive(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return applyRule(setEntitlementGroupActiveRule, input, admin);
}

export async function handleCreateEntitlementGroup(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const { code, display_name, permissions } = input;
  const refused = await checkCreateEntitlementGroup(input, admin);
  if (refused) return refused;
  const granted = Array.isArray(permissions) ? permissions.map(String) : [];

  return runAudited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: {
        type: "create_entitlement_group",
        prompt_action: true,
        code,
        permissions,
      },
    },
    () =>
      failedAsResult(() =>
        catalogTx(async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `insert into entitlement_groups (code, display_name, is_active)
             values ($1, $2, true)
             returning id`,
            [code ?? null, display_name ?? null]
          );
          if (granted.length > 0) {
            await tx.query(
              `insert into entitlement_permissions (entitlement_group_id, permission_id)
               select $1::uuid, p.id from permissions p where p.code = any($2::text[])`,
              [rows[0].id, granted]
            );
          }
          return { success: true, result: `Entitlement "${display_name}" created` };
        })
      )
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A group with the permission codes it grants; null when there is none. Read errors throw. */
export async function groupWithPermissions(
  tx: Tx,
  groupId: string,
  lock: boolean
): Promise<{ id: string; code: string; permissions: string[] } | null> {
  if (!UUID.test(groupId)) return null;
  const { rows } = await tx.query<{ id: string; code: string }>(
    lock
      ? "select id, code from entitlement_groups where id = $1::uuid for update"
      : "select id, code from entitlement_groups where id = $1::uuid",
    [groupId]
  );
  const group = rows[0];
  if (!group) return null;
  const perms = await tx.query<{ code: string }>(
    `select p.code from entitlement_permissions ep
       join permissions p on p.id = ep.permission_id
      where ep.entitlement_group_id = $1::uuid`,
    [group.id]
  );
  return { ...group, permissions: perms.rows.map((p) => p.code) };
}

/**
 * Turn an entitlement group on or off (the PATCH /api/admin/entitlements change, as a governed
 * action): under dual control (admin.dual_control_actions, set_entitlement_group_active) the page
 * holds it and this runs it once a second admin approves (review 7 M6 — an active group grants
 * its permissions to everyone holding it, a change to who holds power that was made by one admin
 * alone). The same rules as the page: only those who may change the catalog, only with every
 * permission the group grants, read again under a lock before the change.
 */
export async function handleSetEntitlementGroupActive(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const groupId = String(input.group_id ?? "");
  const isActive = input.is_active;
  if (typeof isActive !== "boolean" || !UUID.test(groupId)) {
    return typeof isActive !== "boolean"
      ? coded("request.invalid_value", { field: "is_active", allowed: ["true", "false"] })
      : coded("request.invalid_value", {
          field: "group_id",
          allowed: ["an entitlement group id"],
        });
  }
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  const group = await catalogTx((tx) => groupWithPermissions(tx, groupId, false));
  if (!group) return coded("admin.target_not_found", { target: "entitlement group" });
  const refused = checkPermissionGrant(admin, group.permissions);
  if (refused) return refusal(refused);

  const result = await runAudited(
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
    () =>
      failedAsResult(() =>
        catalogTx(async (tx) => {
          const now = await groupWithPermissions(tx, group.id, true);
          if (!now)
            return coded("admin.target_not_found", { target: "entitlement group" });
          const refusedNow = checkPermissionGrant(admin, now.permissions);
          if (refusedNow) return refusal(refusedNow);
          await tx.query(
            "update entitlement_groups set is_active = $2 where id = $1::uuid",
            [now.id, isActive]
          );
          return {
            success: true,
            result: `Entitlement "${now.code}" turned ${isActive ? "on" : "off"}`,
          };
        })
      )
  );
  // Holders' cached permissions change with the group.
  if (result.success) await clearPermissionsCache();
  return result;
}
