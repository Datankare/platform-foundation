/**
 * app/api/admin/ai/handlers/search.ts — search action handlers.
 *
 * Reads only the tables in SEARCHABLE_TABLES, each under the permission its admin page requires
 * (TASK-145). Any other table — and a table whose permission the admin lacks — is refused.
 *
 * Each table has its own fixed statement (SQL text never names a table, a column or an operator
 * from input), run in the tenant's transaction: users and audit_log are the current tenant's rows
 * only (row-level security, ADR-053 D5); the catalog tables and platform_config are shared and
 * read-only.
 *
 * TASK-189 (found in a live check): the statements read `to_jsonb(t)` — every column of every
 * row, so a search of users showed and recorded (in the action's step, agent_trajectories) each
 * account's date of birth, identity-provider subject, real name, ban reason and parental consent
 * address — and the `query` the tool required was never read: every search returned the newest 20
 * rows. Now:
 *
 *   - each table names the columns it shows (SEARCH_COLUMNS), mirroring what that table's admin
 *     page shows under the same permission and nothing more; the statement selects exactly those
 *     columns, and the result is built from that list, so a column added to a table is never
 *     shown until it is named here (`__tests__/task-189-search.test.ts`);
 *   - a search takes typed filters (SEARCH_FILTERS), each a bound parameter of the table's fixed
 *     statement, validated first — a bad value, or a filter the table does not take, is refused
 *     (`request.invalid_value`), never ignored;
 *   - the rows come back as a table (columns and rows) the command bar shows as one; the
 *     recorded step keeps only the rows' ids and counts, the validated filters with the free
 *     text reduced to its length, and only the number of any other keys (searchStepRecord — the
 *     step outlives an account's erasure).
 *
 * Review round 1 (TASK-189): text over 100 characters refused, not cut; a database error logged,
 * never returned; a role matched by name or display name; the match count reported ("Showing 20
 * of N"); users who signed in within a period ordered by their last sign-in; a null filter is
 * absent; a config value shown as JSON. Round 2: the step records an allowlist (no value of a
 * refused or unknown key, the role as its length); `text` with `query` refused.
 *
 * TASK-190 (the owner's live check of Users with "show moderators"): the filters and their one
 * check moved to ../search-filters.ts, shared with the Users list (which now takes the users
 * filters, so the Users screen shows one list, not two) and the confirm panel; the result carries
 * the filters as validated (`table.filters`) for the Users screen to apply; a users row's role is
 * its display name; and the step keeps the number of ignored keys, not their names.
 *
 * Round 1 (TASK-190, S-L1): a result's `id` column is returned only to a caller whose verified
 * role may see it (maySeeIds — admin, super_admin): searchResultFor leaves it out of the execute
 * response for any other role, and the result line never names a row by it. The step still
 * records the rows' ids (searchStepRecord reads the whole result).
 *
 * `query` (the old free-text field): read as the `text` filter, so an older plan that searched for
 * a name still finds it; given with `text`, refused. It is no longer in the tool's schema.
 */

import { withTenantTx } from "@/platform/data";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { AUDIT_ACTIONS } from "@/platform/auth/audit";
import {
  PERMISSION_CATEGORY_ORDER,
  permissionOrderSql,
  roleOrderSql,
} from "@/platform/auth/catalog-order";
import {
  checkSearchFilter,
  maySeeIds,
  parseSearchFilterInput,
  SEARCH_FILTERS,
  SEARCH_TEXT_MAX,
  type Filters,
  type SearchableTable,
  type SearchFilter,
} from "../search-filters";
import { renderMessage } from "@/platform/errors/messages";
import { likeTerm } from "@/lib/pagination";
import { logger } from "@/lib/logger";
import { SEARCHABLE_TABLES } from "../tool-permissions";
import { USER_STATUS_SQL } from "@/app/api/admin/users/listing";
import { refusal, type ActionResult, type SearchCell, type SearchTable } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

// The filters, their limits and their one check are shared with the Users list and the confirm
// panel (TASK-190: ../search-filters.ts); re-exported here for the handler's callers.
export {
  SEARCH_FILTER_NAMES,
  SEARCH_FILTERS,
  SEARCH_MAX_DAYS,
  SEARCH_ROLE_MAX,
  SEARCH_TEXT_MAX,
  SEARCH_USER_STATUSES,
  type Filters,
  type SearchableTable,
  type SearchFilter,
} from "../search-filters";

/** The most rows a search returns (review 11 L-3: the newest, in a stable order). */
export const SEARCH_ROW_LIMIT = 20;

/**
 * The columns each table's search shows, in order — the allowlist (data minimisation). Each
 * mirrors the admin page that requires the same permission (SEARCHABLE_TABLES):
 *
 *   users              The Users screen's list (GET /api/admin/users): id, address, display
 *                      name, role (its display name, else its name — TASK-190), standing (as the status guard reads it — an expired
 *                      restriction is "active", an erased account "deleted") and until when,
 *                      whether the address is verified, created, last sign-in. Never the date of
 *                      birth, the identity provider's subject, the guest token, the real name, the
 *                      ban reason, who changed the standing, the parental consent status or
 *                      address, the age verification — none of which that screen shows.
 *   roles              The Roles page (GET /api/admin/roles): id, name, display name,
 *                      description, created.
 *   permissions        The Roles page's permission list: id, code, display name, category.
 *   role_permissions   The Roles page's grants, by role name and permission code. Not granted_by
 *                      (an administrator's account id, which the Roles page does not show; who
 *                      granted what is on the Audit log page, under admin_view_audit).
 *   entitlement_groups The Entitlements page (GET /api/admin/entitlements): id, code, display
 *                      name, whether it is active. Not created_by.
 *   audit_log          The Audit log page (GET /api/admin/audit) less `details`: id, action,
 *                      actor, target, when. Never the IP address or user agent (the page does not
 *                      show them). `details` is free-form (up to 1 MiB a row) and may carry
 *                      personal data; the page shows it under the same permission, but a search
 *                      records its result in the action's step — a second copy, outside the audit
 *                      log's own retention and erasure — so a search names the entry (its id) and
 *                      the page shows the rest.
 *   platform_config    The Platform config page (GET /api/admin/config): key, the value in
 *                      effect for this tenant (its override, else the platform default), category,
 *                      description, permission tier, whether this tenant overrides it, updated.
 *                      Retired settings are left out, as on the page. Not updated_by.
 */
export const SEARCH_COLUMNS: Readonly<Record<SearchableTable, readonly string[]>> = {
  users: [
    "id",
    "email",
    "display_name",
    "role",
    "status",
    "status_until",
    "email_verified",
    "created_at",
    "last_sign_in_at",
  ],
  roles: ["id", "name", "display_name", "description", "created_at"],
  permissions: ["id", "code", "display_name", "category"],
  role_permissions: ["id", "role", "permission", "created_at"],
  entitlement_groups: ["id", "code", "display_name", "is_active"],
  audit_log: ["id", "action", "actor_id", "target_id", "created_at"],
  platform_config: [
    "key",
    "value",
    "category",
    "description",
    "permission_tier",
    "overridden",
    "updated_at",
  ],
};

/** A substring match of a bound, escaped term (likeTerm); `$1 = ''` turns it off. */
const CONTAINS = (column: string, param: string) =>
  `${column} ilike '%' || ${param} || '%'`;

/**
 * The number of rows that match, before the limit (round 1: a capped result was reported as if it
 * were every match). A window count: computed over the filtered rows, then the 20 are taken.
 */
const TOTAL = "count(*) over () as total";

/**
 * The standing as listedStatus (app/api/admin/users/listing.ts) reads it, in SQL so it can be
 * filtered on before the limit: erased → deleted; a restriction or suspension whose end has
 * passed → active; otherwise the stored standing.
 */
const USER_STATUS = USER_STATUS_SQL;
const USER_STATUS_UNTIL = `case when u.deleted_at is not null then null
         when u.account_status = 'restricted' and u.restricted_until > now() then u.restricted_until
         when u.account_status = 'suspended' and u.suspended_until > now() then u.suspended_until
         end`;

/**
 * The users statement, in one of its two fixed orders. $1 text ('' none), $2 role (its name or
 * display name, case-insensitive), $3 status, $4 signed in within days, $5 created within days.
 */
const usersSql = (
  order: string
) => `select s.id, s.email, s.display_name, s.role, s.status,
                 s.status_until, s.email_verified, s.created_at, s.last_sign_in_at, ${TOTAL}
            from (select u.id, u.email, u.display_name, r.name as role_name,
                         r.display_name as role_display_name,
                         coalesce(nullif(btrim(r.display_name), ''), r.name) as role,
                         ${USER_STATUS} as status, ${USER_STATUS_UNTIL} as status_until,
                         u.email_verified, u.created_at, u.last_login_at as last_sign_in_at
                    from users u left join roles r on r.id = u.role_id) s
           where ($1 = '' or ${CONTAINS("s.email", "$1")} or ${CONTAINS("s.display_name", "$1")})
             and ($2::text is null or lower(s.role_name) = lower($2::text)
                  or lower(s.role_display_name) = lower($2::text))
             and ($3::text is null or s.status = $3::text)
             and ($4::int is null or s.last_sign_in_at >= now() - make_interval(days => $4::int))
             and ($5::int is null or s.created_at >= now() - make_interval(days => $5::int))
           order by ${order} limit ${SEARCH_ROW_LIMIT}`;

/**
 * The statement each table is read with — fixed text, its filters bound parameters in the order
 * searchParams gives them, the 20 newest rows (roles, permissions and role permissions: the first
 * 20 in the Roles screen's order, TASK-192), ties broken by the key so the order is stable.
 * Each selects exactly SEARCH_COLUMNS[table], by name, then the match count.
 */
export const SEARCH_SQL: Readonly<Record<SearchableTable, string>> = {
  users: usersSql("s.created_at desc, s.id"),
  // $1 text. In the Roles screen's order (TASK-192): sort_order, then name.
  roles: `select id, name, display_name, description, created_at, ${TOTAL} from roles
           where ($1 = '' or ${CONTAINS("name", "$1")} or ${CONTAINS("display_name", "$1")})
           order by ${roleOrderSql()}, id limit ${SEARCH_ROW_LIMIT}`,
  // $1 text, $2 the category order (PERMISSION_CATEGORY_ORDER). As the Roles screen orders them
  // (TASK-192 round 1): category, then display name, then code.
  permissions: `select id, code, display_name, category, ${TOTAL} from permissions
                 where ($1 = '' or ${CONTAINS("code", "$1")} or ${CONTAINS("display_name", "$1")}
                        or ${CONTAINS("category", "$1")})
                 order by ${permissionOrderSql("$2")}, id limit ${SEARCH_ROW_LIMIT}`,
  // $1 text, $2 the category order (PERMISSION_CATEGORY_ORDER). As the Roles screen lists them
  // (TASK-192): by role (sort_order, name), then category — those in $2 in its order, any other
  // after them by name, case ignored — then the permission's display name and code.
  role_permissions: `select rp.id, r.name as role, p.code as permission, rp.created_at, ${TOTAL}
                       from role_permissions rp
                       join roles r on r.id = rp.role_id
                       join permissions p on p.id = rp.permission_id
                      where ($1 = '' or ${CONTAINS("r.name", "$1")} or ${CONTAINS("p.code", "$1")})
                      order by ${roleOrderSql("r")}, ${permissionOrderSql("$2", "p")}, rp.id
                      limit ${SEARCH_ROW_LIMIT}`,
  // $1 text
  entitlement_groups: `select id, code, display_name, is_active, ${TOTAL} from entitlement_groups
                        where ($1 = '' or ${CONTAINS("code", "$1")}
                               or ${CONTAINS("display_name", "$1")})
                        order by created_at desc, id limit ${SEARCH_ROW_LIMIT}`,
  // $1 action names (null: any), $2 actor, $3 target, $4 within days
  audit_log: `select id, action, actor_id, target_id, created_at, ${TOTAL} from audit_log
               where ($1::text[] is null or action::text = any($1::text[]))
                 and ($2::uuid is null or actor_id = $2::uuid)
                 and ($3::uuid is null or target_id = $3::uuid)
                 and ($4::int is null or created_at >= now() - make_interval(days => $4::int))
               order by created_at desc, id limit ${SEARCH_ROW_LIMIT}`,
  // $1 text, $2 category
  platform_config: `select c.key, coalesce(o.value, c.value) as value, c.category, c.description,
                           c.permission_tier, (o.key is not null) as overridden,
                           coalesce(o.updated_at, c.updated_at) as updated_at, ${TOTAL}
                      from platform_config c
                      left join tenant_config_overrides o on o.key = c.key
                     where c.category <> 'retired'
                       and ($1 = '' or ${CONTAINS("c.key", "$1")}
                            or ${CONTAINS("c.description", "$1")})
                       and ($2::text is null or c.category = $2::text)
                     order by coalesce(o.updated_at, c.updated_at) desc, c.key
                     limit ${SEARCH_ROW_LIMIT}`,
};

/**
 * Users who signed in within a period, most recent sign-in first (round 1: they were listed by
 * when the account was made). The same statement, in the order the Users screen's "Signed in most
 * recently" uses.
 */
export const SEARCH_USERS_BY_SIGN_IN_SQL = usersSql(
  "s.last_sign_in_at desc nulls last, s.id"
);

/** The statement a search runs: fixed per table (and, for users, per order). */
export function searchSql(table: SearchableTable, f: Filters): string {
  return table === "users" && f.signed_in_within_days !== undefined
    ? SEARCH_USERS_BY_SIGN_IN_SQL
    : SEARCH_SQL[table];
}

type Refused = { ok: false; result: ActionResult };
type Parsed = { ok: true; filters: Filters } | Refused;

/**
 * The input's filters for `table`, each checked by the shared check (../search-filters.ts);
 * anything else in the input is refused (`request.invalid_value`), never ignored.
 */
export function parseSearchFilters(
  table: SearchableTable,
  input: Readonly<Record<string, unknown>>
): Parsed {
  const parsed = parseSearchFilterInput(table, input);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    result: refusal({
      code: "request.invalid_value",
      params: { field: parsed.field, allowed: parsed.allowed },
    }),
  };
}

/** The bound parameters of the table's statement, from its validated filters. */
export function searchParams(table: SearchableTable, f: Filters): unknown[] {
  // The validated text is the admin's own; it is escaped for LIKE here, where it is bound.
  const text = typeof f.text === "string" ? likeTerm(f.text, SEARCH_TEXT_MAX) : "";
  switch (table) {
    case "users":
      return [
        text,
        f.role ?? null,
        f.status ?? null,
        f.signed_in_within_days ?? null,
        f.created_within_days ?? null,
      ];
    case "audit_log": {
      // As the Audit log page searches: the text matches the action names that contain it.
      const term = typeof f.text === "string" ? f.text.toLowerCase() : undefined;
      let actions: string[] | null =
        term === undefined ? null : AUDIT_ACTIONS.filter((a) => a.includes(term));
      if (typeof f.action === "string") {
        const action = f.action;
        actions = actions === null ? [action] : actions.filter((a) => a === action);
      }
      return [actions, f.actor_id ?? null, f.target_id ?? null, f.within_days ?? null];
    }
    case "platform_config":
      return [text, f.category ?? null];
    case "permissions":
    case "role_permissions":
      return [text, [...PERMISSION_CATEGORY_ORDER]];
    default:
      return [text];
  }
}

/**
 * The columns that hold a JSON value: shown as their JSON text — `true`, `5` and `"true"` stay
 * distinguishable (round 1: a config `true` was shown as "Yes").
 */
const JSON_COLUMNS: Readonly<Partial<Record<SearchableTable, readonly string[]>>> = {
  platform_config: ["value"],
};

/** One value as the table shows it: dates as ISO text, a JSON value as its JSON text. */
function cell(value: unknown, json: boolean): SearchCell {
  if (value === null || value === undefined) return null;
  if (json) return JSON.stringify(value) ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  return JSON.stringify(value) ?? null;
}

/** A row as its allowlisted cells — only SEARCH_COLUMNS[table], whatever the row carries. */
export function searchRow(
  table: SearchableTable,
  row: Readonly<Record<string, unknown>>
): SearchCell[] {
  const json = JSON_COLUMNS[table] ?? [];
  return SEARCH_COLUMNS[table].map((column) => cell(row[column], json.includes(column)));
}

export async function handleSearch(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const table = String(input.table ?? "");
  if (!Object.prototype.hasOwnProperty.call(SEARCHABLE_TABLES, table)) {
    return refusal({
      code: "request.invalid_value",
      params: { field: "table", allowed: Object.keys(SEARCHABLE_TABLES).join(", ") },
    });
  }
  const searched = table as SearchableTable;
  const permission = SEARCHABLE_TABLES[searched];
  if (!holds(admin, permission)) {
    return refusal({ code: "auth.permission_denied", params: { permission } });
  }

  const parsed = parseSearchFilters(searched, input);
  if (!parsed.ok) return parsed.result;

  let rows: SearchCell[][];
  let matched: number;
  try {
    const read = await withTenantTx((tx) =>
      tx.query<Record<string, unknown>>(
        searchSql(searched, parsed.filters),
        searchParams(searched, parsed.filters)
      )
    );
    rows = read.rows.map((row) => searchRow(searched, row));
    matched = Number(read.rows[0]?.total ?? 0);
  } catch (err) {
    // The database's message (table, column, constraint) is logged, never shown or recorded
    // (round 1), as failedAsResult does for a write.
    logger.error("Admin command search failed", {
      table: searched,
      error: err instanceof Error ? err.message : String(err),
      route: "app/api/admin/ai/handlers/search",
    });
    return {
      success: false,
      error: renderMessage("screens.admin_console.search.failed"),
    };
  }

  const columns = SEARCH_COLUMNS[searched];
  const fitted = fitSearchRows(rows, columns);
  const shown: SearchTable = {
    table: searched,
    columns: [...columns],
    rows: fitted.shown,
    matched: Math.max(matched, rows.length),
    // The filters as validated and applied — what the Users screen applies to its own list
    // (TASK-190), never the planner's raw input. The admin's screen only: the step records
    // searchStepRecord's form, which does not carry them.
    filters: { ...parsed.filters },
  };
  return {
    success: true,
    // A row left out for size is named by its first column — never by an id the caller may not
    // see (round 1, S-L1).
    result: searchSummary(
      searched,
      shown.matched ?? rows.length,
      fitted,
      SEARCH_RESULT_MAX_BYTES,
      columns[0] !== "id" || maySeeIds(admin.roleName)
    ),
    table: shown,
  };
}

/**
 * A search's result as the caller's screen gets it (TASK-190 round 1, S-L1 — ids were hidden on
 * the screen only): the `id` column is left out unless the caller's verified role may see it
 * (maySeeIds: admin, super_admin). Only `id` — an audit entry's actor_id and target_id stay, as
 * on the Audit log page. Any other result is returned as it is.
 */
export function searchResultFor(
  result: ActionResult,
  admin: Pick<VerifiedAdmin, "roleName">
): ActionResult {
  const table = result.table;
  if (!table || maySeeIds(admin.roleName)) return result;
  const at = table.columns.indexOf("id");
  if (at < 0) return result;
  const keep = (_: unknown, i: number) => i !== at;
  return {
    ...result,
    table: {
      ...table,
      columns: table.columns.filter(keep),
      rows: table.rows.map((row) => row.filter(keep)),
    },
  };
}

/** What a recorded search step says of its text filters: their length, never their words. */
export function redactedText(value: unknown): string {
  return typeof value === "string"
    ? renderMessage("screens.admin_console.search.redacted", {
        length: [...value].length,
      })
    : renderMessage("screens.admin_console.search.redacted", { length: 0 });
}

/** The filters a step records as their length, never their words: the free-text ones. */
const FREE_TEXT_FILTERS: ReadonlySet<string> = new Set(["text", "query", "role"]);

/**
 * The search as its step records it: agent_trajectories outlives an account's erasure (the
 * erasure does not scrub steps), so the step keeps no cell of a row and no value the planner or
 * the admin wrote. It is an allowlist (round 2: a copy of the input less `text`/`query` kept a
 * refused `email: "kid@example.com"`, a free-text role and any object given):
 *   - `table`, only when it is a searchable table;
 *   - for a search that ran, each filter of SEARCH_FILTERS[table] as parsed and validated, with
 *     the free-text ones (`text`, `query`, `role`) reduced to their length;
 *   - how many other keys there were — unknown, invalid, or any key of a refused search —
 *     (`ignored_key_count`), never their names or values: a key's name is data too (TASK-190,
 *     residual b of TASK-189 round 3 — an identifier-shaped name such as `jane_doe` was kept);
 *   - the rows' ids (the first column), how many were shown and matched, and the columns.
 * The admin's screen still gets the whole allowlisted table (command-bar.ts records this form and
 * returns the other).
 */
export function searchStepRecord(
  result: ActionResult,
  input: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const rawTable = input.table;
  const table =
    typeof rawTable === "string" &&
    Object.prototype.hasOwnProperty.call(SEARCHABLE_TABLES, rawTable)
      ? (rawTable as SearchableTable)
      : undefined;
  const filters: Record<string, unknown> = table ? { table } : {};
  let ignored = 0;
  const allowed: readonly string[] = table ? [...SEARCH_FILTERS[table], "query"] : [];
  for (const [key, raw] of Object.entries(input)) {
    if (key === "table") {
      if (table === undefined && raw !== undefined && raw !== null) ignored += 1;
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (!result.success || !allowed.includes(key)) {
      ignored += 1;
      continue;
    }
    const checked = checkSearchFilter(
      key === "query" ? "text" : (key as SearchFilter),
      raw
    );
    if (!checked.ok) {
      ignored += 1;
    } else if (checked.value !== null) {
      filters[key] = FREE_TEXT_FILTERS.has(key) ? redactedText(raw) : checked.value;
    }
  }
  const { table: shown, ...rest } = result;
  return {
    ...rest,
    filters,
    ...(ignored ? { ignored_key_count: ignored } : {}),
    ...(shown
      ? {
          table: {
            table: shown.table,
            columns: shown.columns,
            ids: shown.rows.map((row) => row[0] ?? null),
            shown: shown.rows.length,
            matched: shown.matched ?? shown.rows.length,
          },
        }
      : {}),
  };
}

/**
 * The most a search result holds (256 KiB) — well inside what one recorded step may hold
 * (1 MiB, platform/errors/json-limits.ts). A description or a config value can be long, so the
 * result is cut deliberately, whole rows first, and says so (review 10 M5).
 */
export const SEARCH_RESULT_MAX_BYTES = 256 * 1024;

export interface FittedRows {
  readonly shown: SearchCell[][];
  /** The id (or key: the first column) of each row left out, when it has one. */
  readonly omitted: readonly (string | undefined)[];
}

/**
 * The rows that fit in `maxBytes` with their column names, in order: each row too large to fit
 * is skipped — and named — while later rows that fit are still shown (review 11 L-3: the first
 * oversized row hid every row after it).
 */
export function fitSearchRows(
  rows: readonly SearchCell[][],
  columns: readonly string[],
  maxBytes: number = SEARCH_RESULT_MAX_BYTES
): FittedRows {
  const shown: SearchCell[][] = [];
  const omitted: (string | undefined)[] = [];
  let used = Buffer.byteLength(JSON.stringify(columns), "utf8") + 2; // the rows' brackets
  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1; // and its separator
    if (used + bytes <= maxBytes) {
      shown.push(row);
      used += bytes;
    } else {
      const id = row[0];
      omitted.push(
        typeof id === "string" || typeof id === "number" ? String(id) : undefined
      );
    }
  }
  return { shown, omitted };
}

/**
 * The result's line (round 1: a capped result read as every match, and a result whose every row
 * was too large said "no rows match"): no match; every match shown; or "Showing N of M" — and,
 * when rows were left out for size, which and why.
 */
export function searchSummary(
  table: SearchableTable,
  matched: number,
  fitted: FittedRows,
  maxBytes: number = SEARCH_RESULT_MAX_BYTES,
  /** Name the rows left out (by their first column); false when that is an id the caller may not see. */
  nameRows: boolean = true
): string {
  const shown = fitted.shown.length;
  const key =
    matched === 0 ? "summary_none" : shown === matched ? "summary_all" : "summary_some";
  const line = renderMessage(`screens.admin_console.search.${key}`, {
    shown,
    matched,
    table,
  });
  if (fitted.omitted.length === 0) return line;
  const named = nameRows
    ? fitted.omitted.filter((id): id is string => id !== undefined)
    : [];
  const which = named.length
    ? ` (${named.slice(0, 20).join(", ")}${named.length > 20 ? ", …" : ""})`
    : "";
  return `${line} ${renderMessage("screens.admin_console.search.not_shown", {
    count: fitted.omitted.length,
    which,
    kib: Math.round(maxBytes / 1024),
  })}`;
}
