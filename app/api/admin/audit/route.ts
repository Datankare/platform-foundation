/**
 * app/api/admin/audit/route.ts — Admin audit trail
 *
 * GET: List audit entries with search and pagination
 *
 * The audit log is the tenant's own data (ADR-053 D5): read in the tenant's transaction, so a
 * tenant's administrator sees only that tenant's records.
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantTx } from "@/platform/data";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger } from "@/lib/logger";
import { internalError } from "@/platform/errors";
import { AUDIT_ACTIONS } from "@/platform/auth/audit";
import { pageParams } from "@/lib/pagination";
import { tenantRoute } from "@/platform/tenancy/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Row = {
  id: string;
  action: string;
  actor_id: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_view_audit");
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const { limit, offset } = pageParams(params, {
    maxLimit: 200,
    maxOffset: UUID.test(q) ? 800 : 10_000,
  });

  // Search by bound parameters only (audit B-16/E-15: `q` was spliced into .or(), and ilike on
  // the uuid and enum columns failed with a 500). A UUID matches the actor or the target; any
  // other text matches the action names that contain it.
  let rows: Row[];
  try {
    if (!q) {
      ({ rows } = await withTenantTx((tx) =>
        tx.query<Row>(
          `select id, action, actor_id, target_id, details, created_at from audit_log
            order by created_at desc, id
            limit $1 offset $2`,
          [limit, offset]
        )
      ));
    } else if (UUID.test(q)) {
      ({ rows } = await withTenantTx((tx) =>
        tx.query<Row>(
          `select id, action, actor_id, target_id, details, created_at from audit_log
            where actor_id = $1::uuid or target_id = $1::uuid
            order by created_at desc, id
            limit $2 offset $3`,
          [q, limit, offset]
        )
      ));
    } else {
      const actions = AUDIT_ACTIONS.filter((a) => a.includes(q));
      rows =
        actions.length === 0
          ? []
          : (
              await withTenantTx((tx) =>
                tx.query<Row>(
                  `select id, action, actor_id, target_id, details, created_at from audit_log
                    where action = any($1::audit_action[])
                    order by created_at desc, id
                    limit $2 offset $3`,
                  [actions, limit, offset]
                )
              )
            ).rows;
    }
  } catch (error) {
    logger.error("Admin audit list failed", {
      error: error instanceof Error ? error.message : String(error),
      route: "api/admin/audit",
    });
    return internalError(error, { request, context: "Admin audit query failed" });
  }

  const entries = rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorId: row.actor_id,
    targetId: row.target_id,
    details: JSON.stringify(row.details),
    createdAt: row.created_at.toISOString(),
  }));

  return NextResponse.json({
    entries,
    hasMore: entries.length === limit,
  });
});
