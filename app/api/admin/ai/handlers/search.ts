/**
 * app/api/admin/ai/handlers/search.ts — search action handlers.
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import type { ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function handleSearch(input: Record<string, any>): Promise<ActionResult> {
  const supabase = getSupabaseServiceClient();
  const { table } = input;

  const { data: searchData, error } = await supabase.from(table).select("*").limit(20);

  if (error) return { success: false, error: error.message };
  return {
    success: true,
    result: JSON.stringify(searchData || [], null, 2),
  };
}
