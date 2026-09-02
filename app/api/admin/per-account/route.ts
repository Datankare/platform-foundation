/**
 * app/api/admin/per-account/route.ts — GET per-account feature blocks (Sprint 3c U6).
 *
 * Read-only view for the governance panel. Returns the current user_feature_restrictions
 * rows. Mutations flow through the AI plan → confirm → execute path
 * (handlers/restrictions.ts), not this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getSupabaseServiceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_account_restrictions");
  if (denied) return denied;

  const supabase = getSupabaseServiceClient();
  const { data, error } = await supabase
    .from("user_feature_restrictions" as never)
    .select("user_id, feature, reason, created_by, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ restrictions: data ?? [] });
}
