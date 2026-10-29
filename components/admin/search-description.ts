/**
 * components/admin/search-description.ts — A planned search as the confirm panel describes it
 * (TASK-189 round 1): the table and each filter the plan chose, in words from the catalog
 * (messages/en.json, screens.admin_console.search), so the admin sees what will be read before
 * confirming. Client-safe: no server imports.
 *
 * @module components/admin
 */

import { renderMessage } from "@/platform/errors/messages";

const KEY = "screens.admin_console.search";

/**
 * The filters each table takes — a copy of SEARCH_FILTERS (app/api/admin/ai/handlers/search.ts,
 * server-only), held equal by a test. "query" is the old name of "text", taken by every table.
 */
export const DESCRIBED_FILTERS: Readonly<Record<string, readonly string[]>> = {
  users: ["text", "role", "status", "signed_in_within_days", "created_within_days"],
  roles: ["text"],
  permissions: ["text"],
  role_permissions: ["text"],
  entitlement_groups: ["text"],
  audit_log: ["action", "text", "actor_id", "target_id", "within_days"],
  platform_config: ["text", "category"],
};

/** The day filters: a whole number of days, 1 to 3650 (as search.ts SEARCH_MAX_DAYS). */
const DAY_FILTERS = new Set([
  "signed_in_within_days",
  "created_within_days",
  "within_days",
]);
const MAX_DAYS = 3650;

/** Whether `table` takes the filter and the value is one it could take (else: an invalid value). */
function showable(table: string, name: string, value: unknown): value is string | number {
  const takes = name === "query" || (DESCRIBED_FILTERS[table] ?? []).includes(name);
  if (!takes) return false;
  if (DAY_FILTERS.has(name)) {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= MAX_DAYS
    );
  }
  return typeof value === "string";
}

/**
 * "Search users where role is moderator, signed in within the last 7 days". Only a valid filter
 * the table takes is shown with its value (round 2: a non-numeric day count rendered the raw ICU template); any
 * other key is named as an invalid value the search will refuse, and text with query together as
 * the refusal it is.
 */
export function describeSearch(input: Readonly<Record<string, unknown>>): string {
  const table = String(input.table ?? "");
  const given = (v: unknown) => v !== null && v !== undefined && v !== "";
  const both = given(input.text) && given(input.query);
  const parts: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (name === "table" || !given(value)) continue;
    if (both && (name === "text" || name === "query")) {
      if (name === "text") parts.push(renderMessage(`${KEY}.filters.text_and_query`));
      continue;
    }
    parts.push(
      showable(table, name, value)
        ? renderMessage(`${KEY}.filters.${name}`, { value })
        : renderMessage(`${KEY}.filters.invalid`, { name })
    );
  }
  return parts.length === 0
    ? renderMessage(`${KEY}.plan`, { table })
    : renderMessage(`${KEY}.plan_where`, { table, filters: parts.join(", ") });
}
