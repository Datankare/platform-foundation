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
 *     text reduced to its length, and any other key by name only (searchStepRecord — the step
 *     outlives an account's erasure).
 *
 * Review round 1 (TASK-189): text over 100 characters refused, not cut; a database error logged,
 * never returned; a role matched by name or display name; the match count reported ("Showing 20
 * of N"); users who signed in within a period ordered by their last sign-in; a null filter is
 * absent; a config value shown as JSON. Round 2: the step records an allowlist (no value of a
 * refused or unknown key, the role as its length); `text` with `query` refused.
 *
 * `query` (the old free-text field): read as the `text` filter, so an older plan that searched for
 * a name still finds it; given with `text`, refused. It is no longer in the tool's schema.
 */

import { withTenantTx } from "@/platform/data";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { AUDIT_ACTIONS } from "@/platform/auth/audit";
import { renderMessage } from "@/platform/errors/messages";
import { likeTerm } from "@/lib/pagination";
import { logger } from "@/lib/logger";
import { SEARCHABLE_TABLES } from "../tool-permissions";
import { refusal, type ActionResult, type SearchCell, type SearchTable } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type SearchableTable = keyof typeof SEARCHABLE_TABLES;

/** The most rows a search returns (review 11 L-3: the newest, in a stable order). */
export const SEARCH_ROW_LIMIT = 20;

/**
 * The columns each table's search shows, in order — the allowlist (data minimisation). Each
 * mirrors the admin page that requires the same permission (SEARCHABLE_TABLES):
 *
 *   users              The Users screen's list (GET /api/admin/users): id, address, display
 *                      name, role name, standing (as the status guard reads it — an expired
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

/** Every filter a search may take; each table takes only those in SEARCH_FILTERS. */
export const SEARCH_FILTER_NAMES = [
  "text",
  "role",
  "status",
  "signed_in_within_days",
  "created_within_days",
  "action",
  "actor_id",
  "target_id",
  "within_days",
  "category",
] as const;
export type SearchFilter = (typeof SEARCH_FILTER_NAMES)[number];

/**
 * The filters each table takes. `text` is a substring, case-insensitive, matched as text (the
 * LIKE metacharacters escaped — likeTerm, as the Users screen's search, TASK-185):
 *
 *   users              text: address or display name; role: the role's name; status: the
 *                      standing as shown; signed_in_within_days / created_within_days: 1–3650
 *                      days back
 *   roles              text: name or display name
 *   permissions        text: code, display name or category
 *   role_permissions   text: role name or permission code
 *   entitlement_groups text: code or display name
 *   audit_log          action: one action name; text: the action names that contain it (as the
 *                      Audit log page's search); actor_id / target_id: an account id; within_days
 *   platform_config    text: key or description; category: one category
 *
 * Periods are counted back from now in days, not given as dates: the planner has no clock, so
 * "this week" is 7 days where a date would be a guess.
 */
export const SEARCH_FILTERS: Readonly<Record<SearchableTable, readonly SearchFilter[]>> =
  {
    users: ["text", "role", "status", "signed_in_within_days", "created_within_days"],
    roles: ["text"],
    permissions: ["text"],
    role_permissions: ["text"],
    entitlement_groups: ["text"],
    audit_log: ["action", "text", "actor_id", "target_id", "within_days"],
    platform_config: ["text", "category"],
  };

/** The standings a user search may filter by — what the Users screen shows (listing.ts). */
export const SEARCH_USER_STATUSES = [
  "active",
  "warned",
  "restricted",
  "suspended",
  "banned",
  "deleted",
] as const;

/** The longest period a search reaches back, in days (ten years). */
export const SEARCH_MAX_DAYS = 3650;

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
const USER_STATUS = `case when u.deleted_at is not null then 'deleted'
         when u.account_status = 'restricted' and u.restricted_until <= now() then 'active'
         when u.account_status = 'suspended' and u.suspended_until <= now() then 'active'
         else u.account_status::text end`;
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
            from (select u.id, u.email, u.display_name, r.name as role,
                         r.display_name as role_display_name,
                         ${USER_STATUS} as status, ${USER_STATUS_UNTIL} as status_until,
                         u.email_verified, u.created_at, u.last_login_at as last_sign_in_at
                    from users u left join roles r on r.id = u.role_id) s
           where ($1 = '' or ${CONTAINS("s.email", "$1")} or ${CONTAINS("s.display_name", "$1")})
             and ($2::text is null or lower(s.role) = lower($2::text)
                  or lower(s.role_display_name) = lower($2::text))
             and ($3::text is null or s.status = $3::text)
             and ($4::int is null or s.last_sign_in_at >= now() - make_interval(days => $4::int))
             and ($5::int is null or s.created_at >= now() - make_interval(days => $5::int))
           order by ${order} limit ${SEARCH_ROW_LIMIT}`;

/**
 * The statement each table is read with — fixed text, its filters bound parameters in the order
 * searchParams gives them, the 20 newest rows, ties broken by the key so the order is stable.
 * Each selects exactly SEARCH_COLUMNS[table], by name, then the match count.
 */
export const SEARCH_SQL: Readonly<Record<SearchableTable, string>> = {
  users: usersSql("s.created_at desc, s.id"),
  // $1 text
  roles: `select id, name, display_name, description, created_at, ${TOTAL} from roles
           where ($1 = '' or ${CONTAINS("name", "$1")} or ${CONTAINS("display_name", "$1")})
           order by created_at desc, id limit ${SEARCH_ROW_LIMIT}`,
  // $1 text
  permissions: `select id, code, display_name, category, ${TOTAL} from permissions
                 where ($1 = '' or ${CONTAINS("code", "$1")} or ${CONTAINS("display_name", "$1")}
                        or ${CONTAINS("category", "$1")})
                 order by created_at desc, id limit ${SEARCH_ROW_LIMIT}`,
  // $1 text
  role_permissions: `select rp.id, r.name as role, p.code as permission, rp.created_at, ${TOTAL}
                       from role_permissions rp
                       join roles r on r.id = rp.role_id
                       join permissions p on p.id = rp.permission_id
                      where ($1 = '' or ${CONTAINS("r.name", "$1")} or ${CONTAINS("p.code", "$1")})
                      order by rp.created_at desc, rp.id limit ${SEARCH_ROW_LIMIT}`,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A category: what the catalog holds (codes), nothing else. */
const CODE = /^[\w.-]{1,64}$/;
/** A control character: never part of a name or a search term. */
const CONTROL = /\p{Cc}/u;

/** The longest search text, in characters — longer is refused, never cut (round 1). */
export const SEARCH_TEXT_MAX = 100;
/** The longest role name or display name a role filter may give. */
export const SEARCH_ROLE_MAX = 64;

export type Filters = Partial<Record<SearchFilter, string | number>>;
type Refused = { ok: false; result: ActionResult };
type Parsed = { ok: true; filters: Filters } | Refused;

const invalid = (field: string, allowed: string): Refused => ({
  ok: false,
  result: refusal({ code: "request.invalid_value", params: { field, allowed } }),
});

/** One filter's value, validated: the value to bind, null for none, or the refusal. */
function parseFilter(name: SearchFilter, raw: unknown): Refused | string | number | null {
  if (raw === undefined || raw === null) return null;
  switch (name) {
    case "text": {
      const allowed = `a text of up to ${SEARCH_TEXT_MAX} characters`;
      if (typeof raw !== "string") return invalid(name, allowed);
      // Counted as likeTerm reads it (control characters dropped, trimmed); longer is refused.
      if ([...raw.replace(/\p{Cc}/gu, "").trim()].length > SEARCH_TEXT_MAX) {
        return invalid(name, allowed);
      }
      const term = likeTerm(raw, SEARCH_TEXT_MAX);
      return term === "" ? null : term;
    }
    case "role": {
      const allowed = `a role's name or display name, up to ${SEARCH_ROLE_MAX} characters`;
      if (typeof raw !== "string" || CONTROL.test(raw)) return invalid(name, allowed);
      const value = raw.trim();
      if (value === "" || [...value].length > SEARCH_ROLE_MAX)
        return invalid(name, allowed);
      return value;
    }
    case "category":
      if (typeof raw !== "string" || !CODE.test(raw)) {
        return invalid(name, "a category of letters, digits, _ . or - (up to 64)");
      }
      return raw;
    case "status":
      if (
        typeof raw !== "string" ||
        !(SEARCH_USER_STATUSES as readonly string[]).includes(raw)
      ) {
        return invalid(name, SEARCH_USER_STATUSES.join(", "));
      }
      return raw;
    case "action":
      if (
        typeof raw !== "string" ||
        !(AUDIT_ACTIONS as readonly string[]).includes(raw)
      ) {
        return invalid(name, AUDIT_ACTIONS.join(", "));
      }
      return raw;
    case "actor_id":
    case "target_id":
      if (typeof raw !== "string" || !UUID.test(raw))
        return invalid(name, "an account id");
      return raw.toLowerCase();
    case "signed_in_within_days":
    case "created_within_days":
    case "within_days":
      if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw < 1 ||
        raw > SEARCH_MAX_DAYS
      ) {
        return invalid(name, `a whole number of days from 1 to ${SEARCH_MAX_DAYS}`);
      }
      return raw;
  }
}

const isRefused = (v: unknown): v is Refused =>
  typeof v === "object" && v !== null && (v as Refused).ok === false;

/**
 * The input's filters for `table`, each validated; anything else in the input is refused. A key
 * given as null (or undefined) is absent, whatever its name (round 1: a planner that sends every
 * schema field, unused ones null, was refused).
 */
export function parseSearchFilters(
  table: SearchableTable,
  input: Readonly<Record<string, unknown>>
): Parsed {
  const allowed = SEARCH_FILTERS[table];
  const filters: Filters = {};
  for (const [key, raw] of Object.entries(input)) {
    if (key === "table" || key === "query") continue;
    if (raw === null || raw === undefined) continue;
    if (!(allowed as readonly string[]).includes(key)) {
      return invalid("filters", allowed.join(", "));
    }
    const parsed = parseFilter(key as SearchFilter, raw);
    if (isRefused(parsed)) return parsed;
    if (parsed !== null) filters[key as SearchFilter] = parsed;
  }
  // The old free-text field, read as `text` (see the header). Every table takes `text` (a test
  // holds this). Both given is refused, never one silently dropped (round 2).
  const hasQuery = input.query !== undefined && input.query !== null;
  if (hasQuery && input.text !== undefined && input.text !== null) {
    return invalid("query", "give one of text or query, not both");
  }
  if (filters.text === undefined && hasQuery) {
    const parsed = parseFilter("text", input.query);
    if (isRefused(parsed)) {
      return invalid("query", `a text of up to ${SEARCH_TEXT_MAX} characters`);
    }
    if (parsed !== null) filters.text = parsed;
  }
  return { ok: true, filters };
}

/** likeTerm's escaping undone, for a term matched in code rather than by LIKE. */
function unescapeLike(term: string): string {
  return term.replace(/\\([\\%_])/g, "$1");
}

/** The bound parameters of the table's statement, from its validated filters. */
export function searchParams(table: SearchableTable, f: Filters): unknown[] {
  const text = f.text ?? "";
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
      const term =
        typeof f.text === "string" ? unescapeLike(f.text).toLowerCase() : undefined;
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
  };
  return {
    success: true,
    result: searchSummary(searched, shown.matched ?? rows.length, fitted),
    table: shown,
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

/** A key name as a step may record it: a plain identifier, or a placeholder (a key is data too). */
const KEY_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const recordedKey = (key: string): string =>
  KEY_NAME.test(key) ? key : renderMessage("screens.admin_console.search.redacted_key");

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
 *   - every other key — unknown, invalid, or any key of a refused search — by name only
 *     (`ignored_keys`), never its value;
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
  const ignored: string[] = [];
  const allowed: readonly string[] = table ? [...SEARCH_FILTERS[table], "query"] : [];
  for (const [key, raw] of Object.entries(input)) {
    if (key === "table") {
      if (table === undefined && raw !== undefined && raw !== null) ignored.push(key);
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (!result.success || !allowed.includes(key)) {
      ignored.push(recordedKey(key));
      continue;
    }
    const parsed = parseFilter(key === "query" ? "text" : (key as SearchFilter), raw);
    if (isRefused(parsed)) {
      ignored.push(key);
    } else if (parsed !== null) {
      filters[key] = FREE_TEXT_FILTERS.has(key) ? redactedText(raw) : parsed;
    }
  }
  const { table: shown, ...rest } = result;
  return {
    ...rest,
    filters,
    ...(ignored.length ? { ignored_keys: ignored } : {}),
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
  maxBytes: number = SEARCH_RESULT_MAX_BYTES
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
  const named = fitted.omitted.filter((id): id is string => id !== undefined);
  const which = named.length
    ? ` (${named.slice(0, 20).join(", ")}${named.length > 20 ? ", …" : ""})`
    : "";
  return `${line} ${renderMessage("screens.admin_console.search.not_shown", {
    count: fitted.omitted.length,
    which,
    kib: Math.round(maxBytes / 1024),
  })}`;
}
