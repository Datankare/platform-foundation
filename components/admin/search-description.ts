/**
 * components/admin/search-description.ts — A planned search as the confirm panel describes it
 * (TASK-189 round 1): the table and each filter the plan chose, in words from the catalog
 * (messages/en.json, screens.admin_console.search), so the admin sees what will be read before
 * confirming. Client-safe: no server imports. Each value is checked by the server's own check
 * (app/api/admin/ai/search-filters.ts), so the panel never shows as valid what will be refused.
 *
 * @module components/admin
 */

import { renderMessage } from "@/platform/errors/messages";
import {
  checkSearchFilter,
  SEARCH_FILTERS,
  type FilterValue,
  type SearchableTable,
  type SearchFilter,
} from "@/app/api/admin/ai/search-filters";

const KEY = "screens.admin_console.search";

/**
 * The filters each table takes: the server's own list (TASK-190 — it was a copy, held equal by a
 * test). "query" is the old name of "text", taken by every table.
 */
export const DESCRIBED_FILTERS: Readonly<Record<string, readonly string[]>> =
  SEARCH_FILTERS;

/**
 * The value the panel shows for a filter, or null when the server will refuse it: the table does
 * not take the filter, or the value fails the server's own check (checkSearchFilter — TASK-190,
 * residual a of TASK-189 round 3: an unknown status, a non-UUID id, text over 100 characters or a
 * role over 64 were shown as if the search would run). Undefined: no filter (an empty text).
 */
function shownValue(
  table: string,
  name: string,
  value: unknown
): FilterValue | null | undefined {
  const takes = name === "query" || (DESCRIBED_FILTERS[table] ?? []).includes(name);
  if (!takes || !Object.prototype.hasOwnProperty.call(SEARCH_FILTERS, table)) return null;
  const filter = (name === "query" ? "text" : name) as SearchFilter;
  if (!(SEARCH_FILTERS[table as SearchableTable] as readonly string[]).includes(filter)) {
    return null;
  }
  const checked = checkSearchFilter(filter, value);
  // A text of only spaces or control characters is no filter to the server: not shown at all.
  if (checked.ok) return checked.value === null ? undefined : checked.value;
  return null;
}

/**
 * "Search users where role is moderator, signed in within the last 7 days". Only a filter the
 * table takes, with a value the server's check accepts, is shown with its value (round 2: a
 * non-numeric day count rendered the raw ICU template; TASK-190: any value the server refuses);
 * any other key is named as an invalid value the search will refuse, and text with query together
 * as the refusal it is.
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
    const shown = shownValue(table, name, value);
    if (shown === undefined) continue;
    parts.push(
      shown !== null
        ? renderMessage(`${KEY}.filters.${name}`, { value: shown })
        : renderMessage(`${KEY}.filters.invalid`, { name })
    );
  }
  return parts.length === 0
    ? renderMessage(`${KEY}.plan`, { table })
    : renderMessage(`${KEY}.plan_where`, { table, filters: parts.join(", ") });
}
