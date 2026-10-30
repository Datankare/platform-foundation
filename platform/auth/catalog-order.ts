/**
 * platform/auth/catalog-order.ts — The order roles and permissions are listed in (TASK-192)
 *
 * Client-safe (no imports): the admin routes order with it on the server, the Roles screen groups
 * with it in the browser, and Playform's live admin journey checks a deployment against it.
 *
 * **Roles** are listed by `sort_order`, then name (case-insensitive, then exactly) everywhere (the
 * Roles screen, the Users screen's role picker, the command bar's search and its planner context).
 * Migration 059 sets `sort_order` for the seeded roles from the owner's order — staff first, then
 * the plans from smallest to largest — and moves any other role still at an old default (0 or 99)
 * to NEW_ROLE_SORT_ORDER, the column's default from then on, so "the rest" follow the seeded roles
 * by name; a value a consumer chose is left as it is. The values here and in 059 are the same
 * (the replay and the database test `db/task-192-catalog-order` read both).
 *
 * **Permissions** of a role are grouped by category (its case ignored), the categories in
 * PERMISSION_CATEGORY_ORDER (staff capabilities first, as the roles are; any other category after
 * them, alphabetically), and sorted by display name within a category (then by code).
 *
 * **Names** compare case-insensitively, then exactly, both by Unicode code point — not by locale,
 * so the database orders them the same way: `lower(x) collate "C", x collate "C"` (roleOrderSql,
 * permissionOrderSql; "C" on a UTF-8 database compares bytes, which is code-point order).
 * Postgres's default collation is linguistic (Supabase: en_US.UTF-8) and would order "a_b" and
 * "ab" otherwise than the browser. Parity, precisely (TASK-192 round 2): identical for ASCII and
 * for any text whose lower case JavaScript and the database agree on; the residual is case
 * mapping — `toLowerCase` is Unicode's, `lower()` the database's (its libc or ICU), which can
 * differ for a few characters ("İ", a final sigma). Acceptable for role and permission names.
 * A category is trimmed of the common whitespace (space, tab, newline, carriage return, form
 * feed, vertical tab) in both — JavaScript's `trim` also removes other Unicode spaces, SQL's
 * `btrim` here only those six.
 *
 * @module platform/auth
 */

/** The seeded roles' `sort_order` (migration 059): gaps of 10 leave room for a role between two. */
export const SEEDED_ROLE_SORT_ORDER: Readonly<Record<string, number>> = {
  // Staff
  super_admin: 10,
  admin: 20,
  moderator: 30,
  safety_approver: 40,
  // Plans, smallest to largest
  guest: 50,
  free: 60,
  daily: 70,
  monthly: 80,
  annual: 90,
  lifetime: 100,
};

/**
 * Every other role's `sort_order` — the column's default since 059, and what the command bar's
 * create and duplicate write — so roles not seeded sort after the seeded ones, by name.
 */
export const NEW_ROLE_SORT_ORDER = 1000;

/** A role's place in the list, by its name: its seeded value, else NEW_ROLE_SORT_ORDER. */
export function roleSortOrder(name: string): number {
  return Object.prototype.hasOwnProperty.call(SEEDED_ROLE_SORT_ORDER, name)
    ? SEEDED_ROLE_SORT_ORDER[name]!
    : NEW_ROLE_SORT_ORDER;
}

/** The categories a role's permissions are grouped under, in this order; any other after them. */
export const PERMISSION_CATEGORY_ORDER: readonly string[] = [
  "admin",
  "moderation",
  "gameplay",
  "social",
  "profile",
  "privacy",
];

/** A permission as the admin routes list it. */
export interface ListedPermission {
  readonly code: string;
  readonly displayName: string;
  readonly category: string;
}

/** The whitespace a category is trimmed of, in the code and in SQL (the `btrim` set in permissionOrderSql). */
const CATEGORY_SPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/** A category as it is grouped and ordered: trimmed, lower case ("Admin\t" is "admin"). */
export function normalCategory(category: string): string {
  return category.replace(CATEGORY_SPACE, "").toLowerCase();
}

const known = (category: string): number => {
  const i = PERMISSION_CATEGORY_ORDER.indexOf(category);
  return i < 0 ? PERMISSION_CATEGORY_ORDER.length : i;
};

/**
 * By Unicode code point, as `collate "C"` on a UTF-8 database (round 2: not by UTF-16 code unit,
 * which puts an astral character such as "😀" before "～").
 */
const points = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length - y.length < 0 ? -1 : x.length > y.length ? 1 : 0;
};

/** Case-insensitively, then exactly, by code point (as `lower(x) collate "C", x collate "C"`). */
export function compareNames(a: string, b: string): number {
  return points(a.toLowerCase(), b.toLowerCase()) || points(a, b);
}

/** Categories (case ignored) in PERMISSION_CATEGORY_ORDER, then any other alphabetically. */
export function compareCategories(a: string, b: string): number {
  const x = normalCategory(a);
  const y = normalCategory(b);
  return known(x) - known(y) || points(x, y);
}

/** By category (compareCategories), then display name, then code: a total, stable order. */
export function comparePermissions(a: ListedPermission, b: ListedPermission): number {
  return (
    compareCategories(a.category, b.category) ||
    compareNames(a.displayName, b.displayName) ||
    compareNames(a.code, b.code)
  );
}

/** By sort_order, then name (compareNames) — the order of ROLE_ORDER_SQL. */
export function compareRoles(
  a: { readonly name: string; readonly sortOrder: number },
  b: { readonly name: string; readonly sortOrder: number }
): number {
  return a.sortOrder - b.sortOrder || compareNames(a.name, b.name);
}

/**
 * The roles' ORDER BY, for a table aliased `alias` (or none). Fixed text — no value is in it.
 */
export function roleOrderSql(alias = ""): string {
  const c = alias ? `${alias}.` : "";
  return `${c}sort_order, lower(${c}name) collate "C", ${c}name collate "C"`;
}

/**
 * The permissions' ORDER BY, for a table aliased `alias` (or none), with the category order bound
 * as the parameter `param` (PERMISSION_CATEGORY_ORDER, a text[]). Fixed text — no value is in it.
 */
export function permissionOrderSql(param: string, alias = ""): string {
  const c = alias ? `${alias}.` : "";
  // The six whitespace characters normalCategory trims (round 2: btrim alone trims spaces only;
  // Postgres has no \v escape, so the vertical tab is \x0B).
  const category = `lower(btrim(${c}category, E' \\t\\n\\r\\f\\x0B'))`;
  return [
    `coalesce(array_position(${param}::text[], ${category}), cardinality(${param}::text[]) + 1)`,
    `${category} collate "C"`,
    `lower(${c}display_name) collate "C"`,
    `${c}display_name collate "C"`,
    `lower(${c}code) collate "C"`,
    `${c}code collate "C"`,
  ].join(", ");
}

/** A role's permissions grouped by category (normalCategory), each group and its permissions in order. */
export function groupPermissions<P extends ListedPermission>(
  permissions: readonly P[]
): { category: string; permissions: P[] }[] {
  const groups = new Map<string, P[]>();
  for (const p of [...permissions].sort(comparePermissions)) {
    const key = normalCategory(p.category);
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  return [...groups].map(([category, list]) => ({ category, permissions: list }));
}
