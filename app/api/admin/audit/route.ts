/**
 * app/api/admin/audit/route.ts — Admin audit trail
 *
 * GET: List audit entries with search and pagination
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_view_audit");
  if (denied) return denied;

  const supabase = getSupabaseServiceClient();
  const url = new URL(request.url);
  const search = url.searchParams.get("q") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  let query = supabase
    .from("audit_log")
    .select("id, action, actor_id, target_id, details, created_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(
      `action.ilike.%${search}%,actor_id.ilike.%${search}%,target_id.ilike.%${search}%`
    );
  }

  const { data, error } = await query;

  if (error) {
    logger.error("Admin audit list failed", {
      error: error.message,
      route: "api/admin/audit",
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const entries = (data || []).map(
    (row: {
      id: string;
      action: string;
      actor_id: string | null;
      target_id: string | null;
      details: Record<string, unknown>;
      created_at: string;
    }) => ({
      id: row.id,
      action: row.action,
      actorId: row.actor_id,
      targetId: row.target_id,
      details: JSON.stringify(row.details),
      createdAt: row.created_at,
    })
  );

  return NextResponse.json({
    entries,
    hasMore: entries.length === limit,
  });
}
