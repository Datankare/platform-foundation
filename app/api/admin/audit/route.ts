/**
 * app/api/admin/audit/route.ts — Admin audit trail
 *
 * GET: List audit entries with search and pagination
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger } from "@/lib/logger";
import { internalError } from "@/platform/errors";
import { AUDIT_ACTIONS } from "@/platform/auth/audit";
import { pageParams } from "@/lib/pagination";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_view_audit");
  if (denied) return denied;

  const supabase = getSupabaseServiceClient();
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().toLowerCase();
  // An id search merges the first offset+limit rows of each side: kept within the REST API's
  // default row cap (1,000), so a deep page is exact rather than silently truncated.
  const { limit, offset } = pageParams(params, {
    maxLimit: 200,
    maxOffset: UUID.test(q) ? 800 : 10_000,
  });
  const COLUMNS = "id, action, actor_id, target_id, details, created_at";

  // Search by bound filters only (audit B-16/E-15: `q` was spliced into .or(), and ilike on
  // the uuid and enum columns failed with a 500). A UUID matches the actor or the target; any
  // other text matches the action names that contain it.
  type Row = {
    id: string;
    action: string;
    actor_id: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
    created_at: string;
  };
  const newestFirst = (a: Row, b: Row) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  let data: Row[] | null = null;
  let error: { message: string } | null = null;

  if (!q) {
    const res = await supabase
      .from("audit_log")
      .select(COLUMNS)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    data = res.data as Row[] | null;
    error = res.error;
  } else if (UUID.test(q)) {
    const page = (column: string) =>
      supabase
        .from("audit_log")
        .select(COLUMNS)
        .eq(column, q)
        .order("created_at", { ascending: false })
        .range(0, offset + limit - 1);
    const [asActor, asTarget] = await Promise.all([page("actor_id"), page("target_id")]);
    error = asActor.error ?? asTarget.error;
    const merged = new Map<string, Row>();
    for (const row of [...(asActor.data ?? []), ...(asTarget.data ?? [])] as Row[]) {
      merged.set(row.id, row);
    }
    data = [...merged.values()].sort(newestFirst).slice(offset, offset + limit);
  } else {
    const actions = AUDIT_ACTIONS.filter((a) => a.includes(q));
    if (actions.length === 0) {
      data = [];
    } else {
      const res = await supabase
        .from("audit_log")
        .select(COLUMNS)
        .in("action", actions)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      data = res.data as Row[] | null;
      error = res.error;
    }
  }

  if (error) {
    logger.error("Admin audit list failed", {
      error: error.message,
      route: "api/admin/audit",
    });
    return internalError(error, { request, context: "Admin audit query failed" });
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
