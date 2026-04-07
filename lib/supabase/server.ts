/**
 * lib/supabase/server.ts — Server-side Supabase clients
 *
 * Two clients for different authorization contexts:
 *
 * 1. Service Role Client — bypasses RLS. Used for:
 *    - Admin operations (role management, audit log writes)
 *    - Schema migrations
 *    - Background jobs (guest lifecycle, entitlement expiry)
 *    - GDPR deletion (needs to access all user data)
 *    NEVER expose this client to browser code.
 *
 * 2. User Client — respects RLS. Used for:
 *    - API routes handling user requests
 *    - Passes the user's Cognito JWT so RLS policies can check auth.uid()
 *    This is the JWT bridge: Cognito token → Supabase RLS context.
 *
 * ADR-012: Supabase for DB/RLS, Cognito for auth.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/**
 * Get a Supabase client with the service role key.
 * BYPASSES all RLS policies — use only for admin/system operations.
 *
 * Creates a new client each call (stateless server context).
 */
export function getSupabaseServiceClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"
    );
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Get a Supabase client that operates in the context of a specific user.
 * Passes the user's JWT as the Authorization header so RLS policies
 * can enforce data isolation via auth.uid().
 *
 * This is the Cognito → Supabase JWT bridge.
 *
 * @param accessToken — The user's Cognito JWT (already verified by middleware)
 */
export function getSupabaseUserClient(accessToken: string): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required"
    );
  }

  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
