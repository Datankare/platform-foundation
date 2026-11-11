/**
 * app/api/admin/ai/search-scope.ts — a search reads the screen it was asked on (TASK-202, N-65)
 *
 * The owner asked the Platform config screen for one setting and got three tables back — the
 * config, the permissions and the audit log — because the planner may plan a search of any table
 * the admin may read, and it planned several. A search now reads the current screen's tables
 * unless the request names another: each section has its tables (SECTION_SEARCH_TABLES), and a
 * planned search of a table outside them is dropped from the plan unless the request names that
 * table (TABLE_NAMES — its words as a person says them). What was dropped is said in the plan's
 * message, so the admin can ask for it by name.
 *
 * This narrows a plan; it never widens one. Every action is still checked again by the execute
 * route (the table's own permission included), so a request that names a table the admin may not
 * read is refused there, as before.
 *
 * @module app/api/admin/ai
 */

import type { SEARCHABLE_TABLES } from "./tool-permissions";

export type SearchableTableName = keyof typeof SEARCHABLE_TABLES;

/** The tables a search on each section reads unless the request names another. */
export const SECTION_SEARCH_TABLES: Readonly<
  Record<string, readonly SearchableTableName[]>
> = {
  users: ["users"],
  roles: ["roles", "permissions", "role_permissions"],
  entitlements: ["entitlement_groups", "permissions"],
  audit: ["audit_log"],
  "platform-config": ["platform_config"],
  "password-policy": ["platform_config"],
  "dual-control": ["platform_config"],
  capabilities: ["platform_config"],
  "capability-mapping": ["platform_config"],
};

/**
 * The words that name each table in a request (lower case, matched as whole words). A request
 * that says one of them asks for that table, whichever screen it is on.
 */
export const TABLE_NAMES: Readonly<
  Record<SearchableTableName, readonly (string | readonly string[])[]>
> = {
  // A phrase is its words in order (TASK-206: words matched in the request, never shown).
  users: ["user", "users", "account", "accounts"],
  roles: ["role", "roles"],
  permissions: ["permission", "permissions"],
  role_permissions: [["role", "permissions"], "role_permissions"],
  entitlement_groups: [
    "entitlement",
    "entitlements",
    ["entitlement", "group"],
    ["entitlement", "groups"],
  ],
  audit_log: ["audit", ["audit", "log"], "audit_log"],
  platform_config: ["config", "configuration", "setting", "settings", "platform_config"],
};

/** Whether `prompt` names `table` (a whole word or phrase of TABLE_NAMES, any case). */
export function namesTable(prompt: string, table: SearchableTableName): boolean {
  const text = ` ${prompt.toLowerCase().replace(/[^a-z0-9_]+/g, " ")} `;
  return TABLE_NAMES[table].some((word) =>
    text.includes(` ${typeof word === "string" ? word : word.join(" ")} `)
  );
}

interface PlannedAction {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

/**
 * The plan with each search outside the section's tables dropped, unless the request names its
 * table; and the tables dropped (for the message). A section with no tables of its own (Approvals,
 * Tenant, …) keeps every search: there is no screen's table to prefer.
 */
export function scopeSearches<A extends PlannedAction>(
  section: string,
  prompt: string,
  actions: readonly A[]
): { readonly actions: A[]; readonly dropped: SearchableTableName[] } {
  const own = Object.prototype.hasOwnProperty.call(SECTION_SEARCH_TABLES, section)
    ? SECTION_SEARCH_TABLES[section]
    : undefined;
  if (!own) return { actions: [...actions], dropped: [] };
  const kept: A[] = [];
  const dropped: SearchableTableName[] = [];
  for (const action of actions) {
    const table = action.input?.["table"];
    if (
      action.tool !== "search" ||
      typeof table !== "string" ||
      !Object.prototype.hasOwnProperty.call(TABLE_NAMES, table) ||
      own.includes(table as SearchableTableName) ||
      namesTable(prompt, table as SearchableTableName)
    ) {
      kept.push(action);
      continue;
    }
    if (!dropped.includes(table as SearchableTableName))
      dropped.push(table as SearchableTableName);
  }
  return { actions: kept, dropped };
}
