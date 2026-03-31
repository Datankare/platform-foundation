/**
 * app/api/admin/password-policy/route.ts — Admin password policy
 *
 * GET: Get current global password policy
 * PUT: Update global password policy
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_config");
  if (denied) return denied;

  const supabase = getSupabaseServiceClient();

  // Global policy: both role_id and player_id are null
  const { data } = await supabase
    .from("password_policy")
    .select("*")
    .is("role_id", null)
    .is("player_id", null)
    .single();

  const policy = data
    ? {
        minLength: data.min_length as number,
        rotationDays: data.rotation_days as number,
        requireUppercase: data.require_uppercase as boolean,
        requireLowercase: data.require_lowercase as boolean,
        requireNumber: data.require_number as boolean,
        requireSpecial: data.require_special as boolean,
        passwordHistoryCount: data.password_history_count as number,
      }
    : {
        minLength: 12,
        rotationDays: 90,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSpecial: true,
        passwordHistoryCount: 5,
      };

  return NextResponse.json({ policy });
}

export async function PUT(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_config");
  if (denied) return denied;

  const body = await request.json();

  const supabase = getSupabaseServiceClient();

  const { error } = await supabase.from("password_policy").upsert(
    {
      role_id: null,
      player_id: null,
      min_length: body.minLength,
      rotation_days: body.rotationDays,
      require_uppercase: body.requireUppercase,
      require_lowercase: body.requireLowercase,
      require_number: body.requireNumber,
      require_special: body.requireSpecial,
      password_history_count: body.passwordHistoryCount,
    },
    { onConflict: "role_id,player_id" }
  );

  if (error) {
    logger.error("Password policy update failed", {
      error: error.message,
      route: "api/admin/password-policy",
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await writeAuditLog({
    action: "admin_action",
    actorId: "dev-admin",
    details: { type: "password_policy_updated", ...body },
  });

  return NextResponse.json({ success: true });
}
