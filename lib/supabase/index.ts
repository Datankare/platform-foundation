/**
 * lib/supabase/index.ts — Supabase module public API
 *
 * Import from here:
 *   import { getSupabaseBrowserClient } from "@/lib/supabase";
 *   import { getSupabaseServiceClient, getSupabaseUserClient } from "@/lib/supabase";
 */

export { getSupabaseBrowserClient } from "@/lib/supabase/client";
export { getSupabaseServiceClient, getSupabaseUserClient } from "@/lib/supabase/server";
export type { Database } from "@/lib/supabase/types";
