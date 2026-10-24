/**
 * app/api/admin/entitlements/route.ts — Admin entitlement management
 *
 * GET: List entitlement groups with user counts
 * PATCH: Turn a group on or off — refused unless the admin holds every permission it grants
 *
 * Entitlement groups are the platform catalog every tenant shares (ADR-053 D5). The list shows
 * them with this tenant's holders only (user_entitlements is tenant data). Turning a group on or
 * off changes it for every tenant, so it is allowed only when mayChangePlatformCatalog(admin) —
 * a single-tenant deployment's administrators, a shared deployment's operators — and runs on the
 * owner connection, where the group's permissions are read again, locked, before the change.
 */

import { NextRequest, NextResponse } from "next/server";
import { withOwnerTx, withTenantTx, type Tx } from "@/platform/data";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { checkPermissionGrant, type RoleRefusal } from "@/platform/auth/role-governance";
import { mayChangePlatformCatalog } from "@/platform/admin/config-scope";
import { clearPermissionsCache } from "@/platform/auth/permissions-cache";
import { auditedResponse } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";

type GroupRow = { id: string; code: string; display_name: string; is_active: boolean };

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_entitlements");
  if (denied) return denied;

  let groups: GroupRow[];
  try {
    ({ rows: groups } = await withTenantTx((tx) =>
      tx.query<GroupRow>(
        "select id, code, display_name, is_active from entitlement_groups order by code"
      )
    ));
  } catch (error) {
    logger.error("Admin entitlements list failed", {
      error: error instanceof Error ? error.message : String(error),
      route: "api/admin/entitlements",
    });
    return internalError(error, { request, context: "Admin entitlements query failed" });
  }

  // This tenant's active holders per group; an unreadable count reads as none, as before.
  const userCounts = new Map<string, number>();
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ entitlement_group_id: string; n: number }>(
        `select entitlement_group_id, count(*)::int as n from user_entitlements
          where revoked_at is null
          group by entitlement_group_id`
      )
    );
    for (const r of rows) userCounts.set(r.entitlement_group_id, r.n);
  } catch (error) {
    logger.warn("Admin entitlement holder counts unreadable", {
      error: error instanceof Error ? error.message : String(error),
      route: "api/admin/entitlements",
    });
  }

  const result = groups.map((g) => ({
    id: g.id,
    code: g.code,
    displayName: g.display_name,
    isActive: g.is_active,
    userCount: userCounts.get(g.id) || 0,
  }));

  return NextResponse.json({ groups: result });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A group with the permission codes it grants; null when there is none. Read errors throw. */
async function groupWithPermissions(
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

export const PATCH = tenantRoute(async function PATCH(request: NextRequest) {
  const verified = await requireAdmin(request, "admin_manage_entitlements");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as { groupId?: unknown; isActive?: unknown };
  const { groupId, isActive } = body ?? {};

  if (typeof groupId !== "string" || !groupId || typeof isActive !== "boolean") {
    return apiError("request.missing_fields", {
      params: { fields: ["groupId", "isActive"] },
      request,
    });
  }

  // A group is shared by every tenant: only those who may change the catalog turn it on or off.
  if (!mayChangePlatformCatalog(admin)) {
    return apiError("admin.operator_only", { request });
  }

  // An active group grants its permissions to everyone who holds it, so turning one on or off
  // is granting or removing those permissions (TASK-145): the admin must hold every one.
  // An unread permission list is not an empty one: it stops the change (release review).
  let group: Awaited<ReturnType<typeof groupWithPermissions>>;
  try {
    group = await withOwnerTx("operator", (tx) =>
      groupWithPermissions(tx, groupId, false)
    );
  } catch (error) {
    logger.error("Entitlement group permissions unreadable", {
      route: "api/admin/entitlements",
      error: error instanceof Error ? error.message : String(error),
    });
    return apiError("service.unavailable", {
      params: { service: "entitlements" },
      request,
    });
  }
  if (!group) {
    return apiError("admin.target_not_found", {
      params: { target: "entitlement" },
      request,
    });
  }
  const refused = checkPermissionGrant(admin, group.permissions);
  if (refused) return apiError(refused.code, { params: refused.params, request });
  const groupIdChecked = group.id;

  return auditedResponse(
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
    async () => {
      let outcome: "changed" | "gone" | RoleRefusal;
      try {
        outcome = await withOwnerTx(
          "operator",
          async (tx): Promise<"changed" | "gone" | RoleRefusal> => {
            // Locked and checked again: the permissions granted are the ones just checked.
            const now = await groupWithPermissions(tx, groupIdChecked, true);
            if (!now) return "gone";
            const refusedNow = checkPermissionGrant(admin, now.permissions);
            if (refusedNow) return refusedNow;
            await tx.query(
              "update entitlement_groups set is_active = $2 where id = $1::uuid",
              [now.id, isActive]
            );
            return "changed";
          }
        );
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          response: internalError(error, {
            request,
            context: "Admin entitlements query failed",
          }),
        };
      }
      if (outcome === "gone") {
        return {
          success: false,
          error: "the group was removed before the change",
          response: apiError("admin.target_not_found", {
            params: { target: "entitlement" },
            request,
          }),
        };
      }
      if (outcome !== "changed") {
        return {
          success: false,
          error: outcome.code,
          response: apiError(outcome.code, { params: outcome.params, request }),
        };
      }
      // Holders' cached permissions change with the group.
      clearPermissionsCache();
      return { success: true, response: NextResponse.json({ success: true }) };
    },
    () => apiError("service.unavailable", { params: { service: "audit" }, request })
  );
});
