/**
 * app/api/admin/ai/handlers/search.ts — search action handlers.
 *
 * Reads only the tables in SEARCHABLE_TABLES, each under the permission its admin page requires
 * (TASK-145). Any other table — and a table whose permission the admin lacks — is refused.
 *
 * Each table has its own fixed statement (SQL text never names a table from input), run in the
 * tenant's transaction: users and audit_log are the current tenant's rows only (row-level
 * security, ADR-053 D5); the catalog tables and platform_config are shared and read-only.
 */

import { withTenantTx } from "@/platform/data";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { SEARCHABLE_TABLES } from "../tool-permissions";
import { refusal, type ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The statement each searchable table is read with: the 20 newest rows, as JSON (review 11 L-3:
 * with no order, which 20 was arbitrary). Ties broken by the key, so the order is stable.
 */
const SEARCH_SQL: Readonly<Record<keyof typeof SEARCHABLE_TABLES, string>> = {
  users: "select to_jsonb(t) as r from users t order by t.created_at desc, t.id limit 20",
  roles: "select to_jsonb(t) as r from roles t order by t.created_at desc, t.id limit 20",
  permissions:
    "select to_jsonb(t) as r from permissions t order by t.created_at desc, t.id limit 20",
  role_permissions:
    "select to_jsonb(t) as r from role_permissions t order by t.created_at desc, t.id limit 20",
  entitlement_groups:
    "select to_jsonb(t) as r from entitlement_groups t order by t.created_at desc, t.id limit 20",
  audit_log:
    "select to_jsonb(t) as r from audit_log t order by t.created_at desc, t.id limit 20",
  platform_config:
    "select to_jsonb(t) as r from platform_config t order by t.updated_at desc, t.key limit 20",
};

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
  const permission = SEARCHABLE_TABLES[table as keyof typeof SEARCHABLE_TABLES];
  if (!holds(admin, permission)) {
    return refusal({ code: "auth.permission_denied", params: { permission } });
  }

  const sql = SEARCH_SQL[table as keyof typeof SEARCHABLE_TABLES];
  let rows: unknown[];
  try {
    rows = await withTenantTx(async (tx) =>
      (await tx.query<{ r: unknown }>(sql)).rows.map((row) => row.r)
    );
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { success: true, result: searchResultText(rows) };
}

/**
 * The most a search result shows, as text (256 KiB) — well inside what one recorded step may hold
 * (1 MiB, platform/errors/json-limits.ts). An audit_log row alone may hold up to 1 MiB of details,
 * so 20 rows could not be recorded at all (review 10 M5): the result is cut deliberately instead,
 * whole rows first, and says so.
 */
export const SEARCH_RESULT_MAX_BYTES = 256 * 1024;

/** A row's id (or key) for the note naming it, when it has one. */
function rowId(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  const id = r.id ?? r.key;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/**
 * `rows` as the command bar shows them: every row that fits, in order, each too large to fit
 * skipped — and named in the note — while later rows that fit are still shown (review 11 L-3: the
 * first oversized row hid every row after it).
 */
export function searchResultText(
  rows: readonly unknown[],
  maxBytes: number = SEARCH_RESULT_MAX_BYTES
): string {
  const shown: unknown[] = [];
  let used = 2; // the brackets
  const omitted: (string | undefined)[] = [];
  for (const row of rows) {
    const text = JSON.stringify(row, null, 2) ?? "null";
    // As it is written inside the list: each line indented two more, and the separator.
    const bytes = Buffer.byteLength(text, "utf8") + 2 * text.split("\n").length + 2;
    if (used + bytes <= maxBytes) {
      shown.push(row);
      used += bytes;
    } else {
      omitted.push(rowId(row));
    }
  }
  const body = JSON.stringify(shown, null, 2);
  if (omitted.length === 0) return body;
  const named = omitted.filter((id): id is string => id !== undefined);
  const which = named.length
    ? ` (${named.slice(0, 20).join(", ")}${named.length > 20 ? ", …" : ""})`
    : "";
  return `${body}\n… ${omitted.length} row${omitted.length === 1 ? "" : "s"} not shown${which}: the result is limited to ${Math.round(maxBytes / 1024)} KiB (showing ${shown.length} of ${rows.length}).`;
}
