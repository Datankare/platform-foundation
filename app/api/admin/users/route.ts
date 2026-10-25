/**
 * app/api/admin/users/route.ts — Admin user management
 *
 * GET: List users (search, pagination)
 * PATCH: Update user role
 *
 * Users are the tenant's own data (ADR-053 D5): both run in the tenant's transaction, so a
 * tenant's administrator lists and changes only that tenant's users. The roles are the shared
 * catalog; assigning one to a user is a tenant change, under the role rules.
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantTx } from "@/platform/data";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { checkRoleAssignment, type RoleRefusal } from "@/platform/auth/role-governance";
import { findRole, findUser } from "@/platform/auth/role-lookup";
import { auditedResponse } from "@/platform/auth/audit";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import { logger } from "@/lib/logger";
import { likeTerm, pageParams } from "@/lib/pagination";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";
import {
  COMMAND_BAR_ACTOR_ID,
  isDualControlledAction,
  runCommandBarAction,
} from "@/app/api/admin/ai/command-bar";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";

type UserRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  role_id: string;
  created_at: Date;
  deleted_at: Date | null;
};
type RoleRow = { id: string; name: string; display_name: string };

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_users");
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const term = likeTerm(params.get("q"));
  const { limit, offset } = pageParams(params, {
    maxLimit: 100,
    maxOffset: term ? 900 : 10_000,
  });

  // Search is a bound parameter matched as text — never filter syntax built from input
  // (audit B-16: `q` was spliced into .or()). likeTerm strips the LIKE wildcards.
  let users: UserRow[];
  let roles: RoleRow[];
  try {
    ({ users, roles } = await withTenantTx(async (tx) => {
      const page = term
        ? await tx.query<UserRow>(
            `select id, email, display_name, role_id, created_at, deleted_at from users
              where email ilike '%' || $1 || '%' or display_name ilike '%' || $1 || '%'
              order by created_at desc, id
              limit $2 offset $3`,
            [term, limit, offset]
          )
        : await tx.query<UserRow>(
            `select id, email, display_name, role_id, created_at, deleted_at from users
              order by created_at desc, id
              limit $1 offset $2`,
            [limit, offset]
          );
      const catalog = await tx.query<RoleRow>("select id, name, display_name from roles");
      return { users: page.rows, roles: catalog.rows };
    }));
  } catch (error) {
    logger.error("Admin users list failed", {
      error: error instanceof Error ? error.message : String(error),
      route: "api/admin/users",
    });
    return internalError(error, { request, context: "Admin users query failed" });
  }

  const roleMap = new Map(roles.map((r) => [r.id, r.name]));

  return NextResponse.json({
    users: users.map((p) => ({
      id: p.id,
      email: p.email,
      displayName: p.display_name,
      roleName: roleMap.get(p.role_id) || "unknown",
      createdAt: p.created_at.toISOString(),
      isDeleted: !!p.deleted_at,
    })),
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      displayName: r.display_name,
    })),
  });
});

export const PATCH = tenantRoute(async function PATCH(request: NextRequest) {
  const verified = await requireAdmin(request, "admin_manage_users");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as { userId?: unknown; roleId?: unknown };
  const { userId, roleId } = body ?? {};

  if (typeof userId !== "string" || typeof roleId !== "string" || !userId || !roleId) {
    return apiError("request.missing_fields", {
      params: { fields: ["userId", "roleId"] },
      request,
    });
  }

  // TASK-145: the role rules apply before any change — no self-change, no protected role, no
  // granting or removing permissions the admin does not hold.
  // A lookup that cannot be answered stops the change (503) — an unread role would otherwise
  // pass the rules as a role with no permissions (release review, Sprint 7X).
  let target: Awaited<ReturnType<typeof findUser>>;
  let newRole: Awaited<ReturnType<typeof findRole>>;
  let currentRole: Awaited<ReturnType<typeof findRole>> = null;
  try {
    ({ target, newRole, currentRole } = await withTenantTx(async (tx) => {
      const user = await findUser(tx, userId);
      return {
        target: user,
        newRole: await findRole(tx, { id: roleId }),
        currentRole: user?.roleId ? await findRole(tx, { id: user.roleId }) : null,
      };
    }));
  } catch (err) {
    logger.error("Role change lookup failed", {
      route: "api/admin/users",
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError("service.unavailable", { params: { service: "roles" }, request });
  }
  if (!target) {
    return apiError("admin.target_not_found", { params: { target: "user" }, request });
  }
  if (!newRole) {
    return apiError("admin.target_not_found", { params: { target: "role" }, request });
  }
  // A user whose current role cannot be found is not changed: the protected-role rule could
  // not be applied to it.
  if (target.roleId && !currentRole) {
    return apiError("admin.target_not_found", { params: { target: "role" }, request });
  }
  const refused = checkRoleAssignment(admin, target.id, newRole, currentRole);
  if (refused) return apiError(refused.code, { params: refused.params, request });

  // A role change under dual control (admin.dual_control_actions, change_user_role) is held for
  // a second admin here as in the command bar — this page is not the weaker second path
  // (audit X-10). The hold runs the same governed action when it is approved.
  if (await isDualControlledAction("change_user_role")) {
    try {
      const trajectory = await getTrajectoryStore().create(
        { kind: "agent", id: COMMAND_BAR_ACTOR_ID },
        "admin-users:change_user_role",
        "platform"
      );
      const outcome = await runCommandBarAction({
        tool: "change_user_role",
        input: { user_identifier: target.id, new_role: newRole.name },
        admin,
        trajectoryId: trajectory.trajectory.trajectoryId,
        stepIndex: 0,
      });
      if (outcome.kind === "held") {
        return NextResponse.json(
          { success: false, held: true, proposalId: outcome.proposalId },
          { status: 202 }
        );
      }
      // Ran, but what it wrote is itself waiting for an approval: held, never success.
      if (outcome.result.held) {
        return NextResponse.json(
          {
            success: false,
            held: true,
            ...(outcome.result.proposalId
              ? { proposalId: outcome.result.proposalId }
              : {}),
          },
          { status: 202 }
        );
      }
      return outcome.result.success
        ? NextResponse.json({ success: true })
        : apiError("service.unavailable", { params: { service: "roles" }, request });
    } catch (err) {
      return internalError(err, { request, context: "Role change hold failed" });
    }
  }

  return auditedResponse(
    {
      action: "role_changed",
      actorId: admin.userId,
      targetId: target.id,
      details: {
        oldRoleId: currentRole?.id ?? null,
        oldRole: currentRole?.name ?? null,
        newRoleId: newRole.id,
        newRole: newRole.name,
      },
    },
    async () => {
      // The user is locked and the rules applied again to what the update changes.
      let outcome: "changed" | "gone" | RoleRefusal;
      try {
        outcome = await withTenantTx(
          async (tx): Promise<"changed" | "gone" | RoleRefusal> => {
            const user = await findUser(tx, target.id, { forUpdate: true });
            const current = user?.roleId ? await findRole(tx, { id: user.roleId }) : null;
            const role = await findRole(tx, { id: newRole.id });
            if (!user || !role || (user.roleId && !current)) return "gone";
            const now = checkRoleAssignment(admin, user.id, role, current);
            if (now) return now;
            await tx.query("update users set role_id = $2::uuid where id = $1::uuid", [
              user.id,
              role.id,
            ]);
            return "changed";
          }
        );
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          response: internalError(error, {
            request,
            context: "Admin users query failed",
          }),
        };
      }
      if (outcome === "gone") {
        return {
          success: false,
          error: "the user or role changed before the update",
          response: apiError("admin.target_not_found", {
            params: { target: "user" },
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
      if (target.cognitoSub) await invalidatePermissions(target.cognitoSub);
      return { success: true, response: NextResponse.json({ success: true }) };
    },
    () => apiError("service.unavailable", { params: { service: "audit" }, request })
  );
});
