/**
 * app/api/admin/users/route.ts — Admin user management
 *
 * GET: List users — searched, sorted and paged on the server (TASK-185)
 * PATCH: Update user role
 *
 * Users are the tenant's own data (ADR-053 D5): both run in the tenant's transaction, so a
 * tenant's administrator lists and changes only that tenant's users. The roles are the shared
 * catalog; assigning one to a user is a tenant change, under the role rules.
 *
 * GET ?q=&sort=created|last_sign_in&dir=desc|asc&limit=&offset=
 *     &text=&role=&status=&signed_in_within_days=&created_within_days= →
 *   { users: [{ id, email, displayName, roleId, roleName, roleDisplayName, status, statusUntil,
 *               emailVerified, createdAt, lastSignInAt, entitlements: [{ code, name, expiresAt }] }],
 *     roles: [{ id, name, displayName }],
 *     page: { limit, offset, hasMore, sort, dir } }
 *
 *   - search (`q`): a substring of the address or the display name, a bound parameter matched as
 *     text — never filter syntax built from input (audit B-16); likeTerm escapes the LIKE
 *     metacharacters (`john_doe` finds john_doe, not johnXdoe), drops control characters and
 *     bounds the term to 100 characters. Not indexed: as the request role, under row-level
 *     security, `ilike` (not leakproof) is applied after the tenant policy, so a search reads the
 *     tenant's accounts (users_tenant_idx) — bounded by the statement timeout
 *     (DATABASE_STATEMENT_TIMEOUT_MS), the page size and the offset cap (900 with a search);
 *   - sort and direction: one of four fixed statements, chosen by name — an unknown name is
 *     refused (request.invalid_value), never written into SQL. Each is served by one index of
 *     migration 056, read forwards or backwards: the ascending orders break ties by `id desc` so
 *     the backward scan needs no sort;
 *   - filters (TASK-190 — one list, not two): the command bar's users-search filters, so the
 *     Users screen applies a search's filters to this list instead of drawing a second table.
 *     Each is checked by the search's own check (app/api/admin/ai/search-filters.ts
 *     parseUserListFilters): role ≤64 characters, matched on the role's name or display name in
 *     any case; status one of the standings; day windows 1–3650; text ≤100 characters, escaped by
 *     likeTerm as the search's. A bad value, or a filter given twice, is refused
 *     (request.invalid_value). Bound parameters only; the same bounded scan as a search;
 *   - paging: at most 100 a page, an offset of at most 10,000 (900 with a search or a filter); one row more is
 *     read to say whether there is a next page — no count of the table;
 *   - status: the account's standing as the status guard reads it — an expired restriction or
 *     suspension is "active" — or "deleted" for an account erased and awaiting its purge;
 *   - email: NULL for an account whose address was never recorded — it is recorded from a
 *     trusted, verified claim at a later sign-in (TASK-185); an account that signs in through a
 *     provider that is not allow-listed, or does not verify the address, keeps NULL.
 *     lastSignInAt: users.last_login_at, NULL when no sign-in was recorded — the screen tells the
 *     two apart;
 *   - entitlements: the page's accounts' current grants — unrevoked, unexpired, of an active
 *     group, as platform/auth/entitlements.ts counts them (one bounded query for the page).
 *
 * What it does not show, and why: whether an authenticator is enrolled (the platform does not
 * record it — users.mfa_enabled is never written; the identity provider holds it), and whether an
 * identity belongs to a previous identity pool (users.cognito_sub does not say which pool issued
 * it; only the pool can answer, with operator credentials).
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
import { parseUserListFilters, SEARCH_TEXT_MAX } from "@/app/api/admin/ai/search-filters";
import {
  USER_SORTS,
  USER_SORT_DIRECTIONS,
  listedStatus,
  USER_STATUS_SQL,
  type SortDirection,
  type UserSort,
} from "@/app/api/admin/users/listing";

type UserRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  role_id: string;
  created_at: Date;
  deleted_at: Date | null;
  account_status: string;
  restricted_until: Date | null;
  suspended_until: Date | null;
  email_verified: boolean;
  last_login_at: Date | null;
};
type RoleRow = { id: string; name: string; display_name: string };
type GrantRow = {
  user_id: string;
  code: string;
  display_name: string;
  expires_at: Date | null;
};

const COLUMNS = `u.id, u.email, u.display_name, u.role_id, u.created_at, u.deleted_at,
                 u.account_status, u.restricted_until, u.suspended_until, u.email_verified,
                 u.last_login_at`;
/**
 * $1: the search term ('' for none), $2: limit + 1, $3: offset; the command bar's users filters
 * (TASK-190), each null when absent — $4 text ('' for none; the search box's term and this both
 * apply), $5 role (its name or display name, any case), $6 status (as listedStatus reads it:
 * USER_STATUS_SQL), $7 signed in within days, $8 created within days. The same conditions as the
 * command bar's users search (handlers/search.ts usersSql), so the list shows what it matched.
 */
const FILTER = `where ($1 = '' or u.email ilike '%' || $1 || '%' or u.display_name ilike '%' || $1 || '%')
    and ($4 = '' or u.email ilike '%' || $4 || '%' or u.display_name ilike '%' || $4 || '%')
    and ($5::text is null or exists (select 1 from roles r where r.id = u.role_id
          and (lower(r.name) = lower($5::text) or lower(r.display_name) = lower($5::text))))
    and ($6::text is null or ${USER_STATUS_SQL} = $6::text)
    and ($7::int is null or u.last_login_at >= now() - make_interval(days => $7::int))
    and ($8::int is null or u.created_at >= now() - make_interval(days => $8::int))`;

/** One fixed statement per order — chosen by name, never assembled from the request. */
const PAGE_SQL: Readonly<Record<`${UserSort}:${SortDirection}`, string>> = {
  "created:desc": `select ${COLUMNS} from users u ${FILTER}
                    order by u.created_at desc, u.id limit $2 offset $3`,
  "created:asc": `select ${COLUMNS} from users u ${FILTER}
                   order by u.created_at asc, u.id desc limit $2 offset $3`,
  "last_sign_in:desc": `select ${COLUMNS} from users u ${FILTER}
                         order by u.last_login_at desc nulls last, u.id limit $2 offset $3`,
  "last_sign_in:asc": `select ${COLUMNS} from users u ${FILTER}
                        order by u.last_login_at asc nulls first, u.id desc limit $2 offset $3`,
};

const GRANTS_SQL = `select ue.user_id, g.code, g.display_name, ue.expires_at
                      from user_entitlements ue
                      join entitlement_groups g on g.id = ue.entitlement_group_id
                     where ue.user_id = any($1::uuid[]) and ue.revoked_at is null
                       and (ue.expires_at is null or ue.expires_at > now())
                     and g.is_active
                     order by g.code`;

function choice<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T
): T | null {
  if (raw === null || raw === "") return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_users");
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const sort = choice(params.get("sort"), USER_SORTS, "created");
  if (!sort) {
    return apiError("request.invalid_value", {
      params: { field: "sort", allowed: [...USER_SORTS] },
      request,
    });
  }
  const dir = choice(params.get("dir"), USER_SORT_DIRECTIONS, "desc");
  if (!dir) {
    return apiError("request.invalid_value", {
      params: { field: "dir", allowed: [...USER_SORT_DIRECTIONS] },
      request,
    });
  }
  const term = likeTerm(params.get("q"));
  // The command bar's users filters (TASK-190), checked exactly as its search checks them
  // (app/api/admin/ai/search-filters.ts): a bad value is refused, never ignored.
  const parsed = parseUserListFilters(params);
  if (!parsed.ok) {
    return apiError("request.invalid_value", {
      params: { field: parsed.field, allowed: parsed.allowed },
      request,
    });
  }
  const f = parsed.filters;
  const filtered = term !== "" || Object.keys(f).length > 0;
  const { limit, offset } = pageParams(params, {
    maxLimit: 100,
    maxOffset: filtered ? 900 : 10_000,
  });

  let users: UserRow[];
  let roles: RoleRow[];
  let grants: GrantRow[];
  try {
    ({ users, roles, grants } = await withTenantTx(async (tx) => {
      const page = await tx.query<UserRow>(PAGE_SQL[`${sort}:${dir}`], [
        term,
        limit + 1,
        offset,
        typeof f.text === "string" ? likeTerm(f.text, SEARCH_TEXT_MAX) : "",
        f.role ?? null,
        f.status ?? null,
        f.signed_in_within_days ?? null,
        f.created_within_days ?? null,
      ]);
      const ids = page.rows.slice(0, limit).map((u) => u.id);
      const granted = ids.length
        ? (await tx.query<GrantRow>(GRANTS_SQL, [ids])).rows
        : [];
      const catalog = await tx.query<RoleRow>("select id, name, display_name from roles");
      return { users: page.rows, roles: catalog.rows, grants: granted };
    }));
  } catch (error) {
    logger.error("Admin users list failed", {
      error: error instanceof Error ? error.message : String(error),
      route: "api/admin/users",
    });
    return internalError(error, { request, context: "Admin users query failed" });
  }

  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const grantsOf = new Map<string, GrantRow[]>();
  for (const g of grants)
    grantsOf.set(g.user_id, [...(grantsOf.get(g.user_id) ?? []), g]);
  const shown = users.slice(0, limit);

  const response = NextResponse.json({
    users: shown.map((p) => {
      const role = roleMap.get(p.role_id);
      const { status, until } = listedStatus(p);
      return {
        id: p.id,
        email: p.email,
        displayName: p.display_name,
        roleId: p.role_id,
        roleName: role?.name ?? "unknown",
        roleDisplayName: role?.display_name ?? null,
        status,
        statusUntil: until,
        emailVerified: p.email_verified === true,
        createdAt: p.created_at.toISOString(),
        lastSignInAt: p.last_login_at ? p.last_login_at.toISOString() : null,
        isDeleted: !!p.deleted_at,
        entitlements: (grantsOf.get(p.id) ?? []).map((g) => ({
          code: g.code,
          name: g.display_name,
          expiresAt: g.expires_at ? g.expires_at.toISOString() : null,
        })),
      };
    }),
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      displayName: r.display_name,
    })),
    page: { limit, offset, hasMore: users.length > limit, sort, dir },
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
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
