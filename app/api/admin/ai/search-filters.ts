/**
 * app/api/admin/ai/search-filters.ts — The typed filters a search takes, and the one check of
 * each value (TASK-189, shared in TASK-190)
 *
 * Client-safe (no server imports). Three callers apply the same check, so none can accept what
 * another refuses:
 *
 *   handlers/search.ts           the command bar's search (refuses a bad value before any read)
 *   app/api/admin/users/route.ts the Users list, which takes the users filters as query
 *                                parameters (TASK-190: one list, not two)
 *   components/admin/search-description.ts
 *                                the confirm panel — a value the server will refuse is shown as
 *                                "an invalid value: the search will be refused", never as given
 *                                (TASK-189 round 3, residual a)
 *
 * The check returns the value as it is used: text with control characters dropped and trimmed
 * (the caller escapes it for LIKE with likeTerm when it binds it — the value handed to the
 * screen is the admin's text, not its escaped form), a role trimmed, an id lower-cased, a day
 * count as a number.
 *
 * @module app/api/admin/ai
 */

import { AUDIT_ACTIONS } from "@/platform/auth/audit-actions";
import { SEARCHABLE_TABLES } from "./tool-permissions";

export type SearchableTable = keyof typeof SEARCHABLE_TABLES;

/**
 * The roles that see a search result's `id` column (TASK-190 round 1, S-L1): a data control, not
 * a display one. For any other role the execute response leaves the column out (forCaller in
 * handlers/search.ts), read from the server-verified role (requireAdmin's `roleName`, the source
 * GET /api/admin/session reports); the console offers "Show details" to the same roles.
 */
export const ID_DETAIL_ROLES: readonly string[] = ["admin", "super_admin"];

/** Whether a caller of this role is shown a search result's `id` column. */
export function maySeeIds(roleName: string | null | undefined): boolean {
  return typeof roleName === "string" && ID_DETAIL_ROLES.includes(roleName);
}

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
 *   users              text: address or display name; role: the role's name or display name;
 *                      status: the standing as shown; signed_in_within_days /
 *                      created_within_days: 1–3650 days back
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
/** The users filters — what the Users list (GET /api/admin/users) also takes (TASK-190). */
export const USER_LIST_FILTERS = [
  "text",
  "role",
  "status",
  "signed_in_within_days",
  "created_within_days",
] as const satisfies readonly SearchFilter[];
export type UserListFilter = (typeof USER_LIST_FILTERS)[number];

export const SEARCH_FILTERS: Readonly<Record<SearchableTable, readonly SearchFilter[]>> =
  {
    users: USER_LIST_FILTERS,
    roles: ["text"],
    permissions: ["text"],
    role_permissions: ["text"],
    entitlement_groups: ["text"],
    audit_log: ["action", "text", "actor_id", "target_id", "within_days"],
    platform_config: ["text", "category"],
  };

/** The standings a user search may filter by — what the Users screen shows (users/listing.ts). */
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
/** The longest search text, in characters — longer is refused, never cut (TASK-189 round 1). */
export const SEARCH_TEXT_MAX = 100;
/** The longest role name or display name a role filter may give. */
export const SEARCH_ROLE_MAX = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A category: what the catalog holds (codes), nothing else. */
const CODE = /^[\w.-]{1,64}$/;
/** A control character: never part of a name or a search term. */
const CONTROL = /\p{Cc}/u;

/** A validated value; null for none (an empty text). */
export type FilterValue = string | number;

export type FilterCheck =
  | { readonly ok: true; readonly value: FilterValue | null }
  | { readonly ok: false; readonly field: string; readonly allowed: string };

const refused = (field: string, allowed: string): FilterCheck => ({
  ok: false,
  field,
  allowed,
});

/**
 * One filter's value, checked: the value to use (null for none), or why it is refused — the
 * field and what it allows, as `request.invalid_value` says them. `undefined` and `null` are
 * none: a planner that sends every schema field, the unused ones null, is not refused.
 */
export function checkSearchFilter(name: SearchFilter, raw: unknown): FilterCheck {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  switch (name) {
    case "text": {
      const allowed = `a text of up to ${SEARCH_TEXT_MAX} characters`;
      if (typeof raw !== "string") return refused(name, allowed);
      // Counted as likeTerm reads it (control characters dropped, trimmed); longer is refused.
      const clean = raw.replace(/\p{Cc}/gu, "").trim();
      if ([...clean].length > SEARCH_TEXT_MAX) return refused(name, allowed);
      return { ok: true, value: clean === "" ? null : clean };
    }
    case "role": {
      const allowed = `a role's name or display name, up to ${SEARCH_ROLE_MAX} characters`;
      if (typeof raw !== "string" || CONTROL.test(raw)) return refused(name, allowed);
      const value = raw.trim();
      if (value === "" || [...value].length > SEARCH_ROLE_MAX)
        return refused(name, allowed);
      return { ok: true, value };
    }
    case "category":
      if (typeof raw !== "string" || !CODE.test(raw)) {
        return refused(name, "a category of letters, digits, _ . or - (up to 64)");
      }
      return { ok: true, value: raw };
    case "status":
      if (
        typeof raw !== "string" ||
        !(SEARCH_USER_STATUSES as readonly string[]).includes(raw)
      ) {
        return refused(name, SEARCH_USER_STATUSES.join(", "));
      }
      return { ok: true, value: raw };
    case "action":
      if (
        typeof raw !== "string" ||
        !(AUDIT_ACTIONS as readonly string[]).includes(raw)
      ) {
        return refused(name, AUDIT_ACTIONS.join(", "));
      }
      return { ok: true, value: raw };
    case "actor_id":
    case "target_id":
      if (typeof raw !== "string" || !UUID.test(raw))
        return refused(name, "an account id");
      return { ok: true, value: raw.toLowerCase() };
    case "signed_in_within_days":
    case "created_within_days":
    case "within_days":
      if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw < 1 ||
        raw > SEARCH_MAX_DAYS
      ) {
        return refused(name, `a whole number of days from 1 to ${SEARCH_MAX_DAYS}`);
      }
      return { ok: true, value: raw };
  }
}

/** The validated filters of one search, by name (text unescaped: likeTerm is the binder's). */
export type Filters = Partial<Record<SearchFilter, FilterValue>>;

export type ParsedFilters =
  | { readonly ok: true; readonly filters: Filters }
  | { readonly ok: false; readonly field: string; readonly allowed: string };

/**
 * The input's filters for `table`, each checked; any other key in the input is refused. A key
 * given as null (or undefined) is absent, whatever its name (TASK-189 round 1). `query`, the old
 * name of `text`, is read as `text`; both given is refused (round 2).
 */
export function parseSearchFilterInput(
  table: SearchableTable,
  input: Readonly<Record<string, unknown>>
): ParsedFilters {
  const allowed = SEARCH_FILTERS[table];
  const filters: Filters = {};
  for (const [key, raw] of Object.entries(input)) {
    if (key === "table" || key === "query") continue;
    if (raw === null || raw === undefined) continue;
    if (!(allowed as readonly string[]).includes(key)) {
      return { ok: false, field: "filters", allowed: allowed.join(", ") };
    }
    const checked = checkSearchFilter(key as SearchFilter, raw);
    if (!checked.ok) return checked;
    if (checked.value !== null) filters[key as SearchFilter] = checked.value;
  }
  const hasQuery = input.query !== undefined && input.query !== null;
  if (hasQuery && input.text !== undefined && input.text !== null) {
    return { ok: false, field: "query", allowed: "give one of text or query, not both" };
  }
  if (filters.text === undefined && hasQuery) {
    const checked = checkSearchFilter("text", input.query);
    if (!checked.ok) {
      return {
        ok: false,
        field: "query",
        allowed: `a text of up to ${SEARCH_TEXT_MAX} characters`,
      };
    }
    if (checked.value !== null) filters.text = checked.value;
  }
  return { ok: true, filters };
}

/** A day count as a query parameter carries it: digits only, else left as the text (refused). */
const DIGITS = /^\d{1,9}$/;

/**
 * The users filters from a URL's query parameters (the Users list, TASK-190), checked exactly as
 * a search's: a parameter is text, so a day count given as digits is read as its number and
 * anything else stays text — which the check refuses. An empty parameter is absent (as `q=`
 * and `sort=` on the same list). Parameters that are not users filters are not read here.
 */
export function parseUserListFilters(params: URLSearchParams): ParsedFilters {
  const input: Record<string, unknown> = {};
  for (const name of USER_LIST_FILTERS) {
    const all = params.getAll(name);
    if (all.length === 0) continue;
    // One value per filter: a repeated parameter is refused, never one picked silently.
    if (all.length > 1) {
      return { ok: false, field: name, allowed: "one value" };
    }
    const raw = all[0]!;
    if (raw === "") continue;
    const days = name === "signed_in_within_days" || name === "created_within_days";
    input[name] = days && DIGITS.test(raw) ? Number(raw) : raw;
  }
  return parseSearchFilterInput("users", input);
}
