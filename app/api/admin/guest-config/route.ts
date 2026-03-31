/**
 * app/api/admin/guest-config/route.ts — Admin guest configuration
 *
 * GET: Get current guest config
 * PUT: Update guest config
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

  const { data } = await supabase
    .from("guest_config")
    .select("*")
    .eq("is_active", true)
    .single();

  const config = data
    ? {
        nudgeAfterSessions: data.nudge_after_sessions as number,
        graceAfterSessions: data.grace_after_sessions as number,
        lockoutAfterSessions: data.lockout_after_sessions as number,
        guestTokenTtlHours: data.guest_token_ttl_hours as number,
      }
    : {
        nudgeAfterSessions: 3,
        graceAfterSessions: 7,
        lockoutAfterSessions: 10,
        guestTokenTtlHours: 72,
      };

  return NextResponse.json({ config });
}

export async function PUT(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_config");
  if (denied) return denied;

  const body = await request.json();
  const {
    nudgeAfterSessions,
    graceAfterSessions,
    lockoutAfterSessions,
    guestTokenTtlHours,
  } = body;

  const supabase = getSupabaseServiceClient();

  // Deactivate current config
  await supabase.from("guest_config").update({ is_active: false }).eq("is_active", true);

  // Insert new config
  const { error } = await supabase.from("guest_config").insert({
    nudge_after_sessions: nudgeAfterSessions,
    grace_after_sessions: graceAfterSessions,
    lockout_after_sessions: lockoutAfterSessions,
    guest_token_ttl_hours: guestTokenTtlHours,
    is_active: true,
  });

  if (error) {
    logger.error("Guest config update failed", {
      error: error.message,
      route: "api/admin/guest-config",
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await writeAuditLog({
    action: "admin_action",
    actorId: "dev-admin",
    details: {
      type: "guest_config_updated",
      nudgeAfterSessions,
      graceAfterSessions,
      lockoutAfterSessions,
      guestTokenTtlHours,
    },
  });

  return NextResponse.json({ success: true });
}
