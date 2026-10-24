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
import {
  catalogTx,
  failedAsResult,
  operatorOnly,
  refusal,
  runAudited,
  type ActionResult,
} from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function handleCreateEntitlementGroup(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const { code, display_name, permissions } = input;
  if (!mayChangePlatformCatalog(admin)) return operatorOnly();
  const granted = Array.isArray(permissions) ? permissions.map(String) : [];
  // An entitlement grants its permissions to whoever holds it (TASK-145).
  const refused = checkPermissionGrant(admin, granted);
  if (refused) return refusal(refused);

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
