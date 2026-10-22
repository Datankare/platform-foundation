/**
 * app/api/admin/ai/handlers/search.ts — search action handlers.
 *
 * Reads only the tables in SEARCHABLE_TABLES, each under the permission its admin page requires
 * (TASK-145). Any other table — and a table whose permission the admin lacks — is refused.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { SEARCHABLE_TABLES } from "../tool-permissions";
import { refusal, type ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

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

  const supabase = getSupabaseServiceClient();
  const { data: searchData, error } = await supabase.from(table).select("*").limit(20);

  if (error) return { success: false, error: error.message };
  return {
    success: true,
    result: JSON.stringify(searchData || [], null, 2),
  };
}
