/**
 * lib/supabase/client.ts — Browser-side Supabase client
 *
 * Creates a Supabase client for use in client components (React).
 * Uses the anon (public) key — all data access is governed by RLS policies.
 *
 * Usage:
 *   import { getSupabaseBrowserClient } from "@/lib/supabase/client";
 *   const supabase = getSupabaseBrowserClient();
 *
 * ADR-012: Supabase for DB/RLS, Cognito for auth.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

let browserClient: SupabaseClient<Database> | null = null;

/**
 * Get the singleton Supabase client for browser-side use.
 * Uses the anon key — safe to expose in the browser.
 * RLS policies enforce data isolation.
 */
export function getSupabaseBrowserClient(): SupabaseClient<Database> {
  if (browserClient) return browserClient;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required"
    );
  }

  browserClient = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      // We use Cognito for auth, not Supabase Auth
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return browserClient;
}
