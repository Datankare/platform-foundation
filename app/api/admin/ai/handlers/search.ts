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

/** The statement each searchable table is read with: the first 20 rows, as JSON. */
const SEARCH_SQL: Readonly<Record<keyof typeof SEARCHABLE_TABLES, string>> = {
  users: "select to_jsonb(t) as r from users t limit 20",
  roles: "select to_jsonb(t) as r from roles t limit 20",
  permissions: "select to_jsonb(t) as r from permissions t limit 20",
  role_permissions: "select to_jsonb(t) as r from role_permissions t limit 20",
  entitlement_groups: "select to_jsonb(t) as r from entitlement_groups t limit 20",
  audit_log: "select to_jsonb(t) as r from audit_log t limit 20",
  platform_config: "select to_jsonb(t) as r from platform_config t limit 20",
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
  return {
    success: true,
    result: JSON.stringify(rows, null, 2),
  };
}
