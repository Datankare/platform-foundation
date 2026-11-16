/**
 * app/api/admin/users/list-users.ts — the Users list, read for GET /api/admin/users and
 * POST /api/admin/users/search (TASK-185, TASK-190; TASK-215, audit A-17)
 *
 * One reader for both: the list's parameters — sort, direction, page, search text and the users
 * filters — as a URLSearchParams, whether they came from a URL (GET: never a search text) or from a
 * body (POST …/search: the search box's text, which never travels in a URL). See route.ts for what
 * each parameter means and how it is bound.
 *
 * @module app/api/admin/users
 */

import { NextResponse, type NextRequest } from "next/server";
import { withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import { likeTerm, pageParams } from "@/lib/pagination";
import { apiError, internalError } from "@/platform/errors";
import { roleOrderSql } from "@/platform/auth/catalog-order";
import { parseUserListFilters, SEARCH_TEXT_MAX } from "@/app/api/admin/ai/search-filters";
import {
  USER_COUNT_CAP,
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

/**
 * The count of what the list's conditions match, capped (TASK-216): FILTER's own text with its
 * parameters renumbered for a statement that has no limit and offset — $1 the search term, then
 * $2 text, $3 role, $4 status, $5 signed in within days, $6 created within days — and $7 the
 * cap + 1. A constant made from a constant: nothing of a request is written into it.
 */
const COUNT_PARAM: Readonly<Record<string, string>> = {
  $1: "$1",
  $4: "$2",
  $5: "$3",
  $6: "$4",
  $7: "$5",
  $8: "$6",
};
const COUNT_SQL = `select count(*)::int as n from (select 1 from users u ${FILTER.replace(
  /\$\d/g,
  (p) => COUNT_PARAM[p] ?? p
)} limit $7) matched`;

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

/** The roles for the role picker, in the catalog's order (TASK-192, catalog-order.ts). */
const ROLE_CATALOG_SQL = `select id, name, display_name from roles order by ${roleOrderSql()}`;

/** The list's response for these parameters: a page of users, the role catalog, the page. */
export async function listUsers(
  request: NextRequest,
  params: URLSearchParams
): Promise<NextResponse> {
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
      params: {
        field: parsed.field,
        allowed: [...parsed.allowed],
        ...(parsed.expected ? { expected: parsed.expected } : {}),
        ...(parsed.max !== undefined ? { max: parsed.max } : {}),
      },
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
  let matched: number;
  try {
    ({ users, roles, grants, matched } = await withTenantTx(async (tx) => {
      const text = typeof f.text === "string" ? likeTerm(f.text, SEARCH_TEXT_MAX) : "";
      const conditions = [
        text,
        f.role ?? null,
        f.status ?? null,
        f.signed_in_within_days ?? null,
        f.created_within_days ?? null,
      ];
      const page = await tx.query<UserRow>(PAGE_SQL[`${sort}:${dir}`], [
        term,
        limit + 1,
        offset,
        ...conditions,
      ]);
      const counted = await tx.query<{ n: number }>(COUNT_SQL, [
        term,
        ...conditions,
        USER_COUNT_CAP + 1,
      ]);
      const ids = page.rows.slice(0, limit).map((u) => u.id);
      const granted = ids.length
        ? (await tx.query<GrantRow>(GRANTS_SQL, [ids])).rows
        : [];
      // The role picker's order: the catalog's (TASK-192).
      const catalog = await tx.query<RoleRow>(ROLE_CATALOG_SQL);
      return {
        users: page.rows,
        roles: catalog.rows,
        grants: granted,
        matched: Number(counted.rows[0]?.n ?? 0),
      };
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
    page: {
      limit,
      offset,
      hasMore: users.length > limit,
      sort,
      dir,
      total: Math.min(matched, USER_COUNT_CAP),
      totalCapped: matched > USER_COUNT_CAP,
    },
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
