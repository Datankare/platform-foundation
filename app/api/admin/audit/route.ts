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
import { apiError, internalError } from "@/platform/errors";
import { AUDIT_ACTIONS } from "@/platform/auth/audit";
import { pageParams } from "@/lib/pagination";
import { tenantRoute } from "@/platform/tenancy/route";
import { namedAccounts, type NamedAccount } from "@/platform/admin/account-names";
import { negotiateLocale } from "@/platform/errors/messages";
import { renderRecordedDeep } from "@/platform/errors/recorded-words";
import type { ResponseSchema } from "@/platform/errors/response-schema";

/**
 * A row's actor or target as the screen names it (TASK-202, N-63): an account of this tenant by
 * its address (null once erased) and role; anything else — an id that is no account (a role, a
 * setting, an agent) — is absent, and the screen shows the row's id as a detail.
 */
function shownAccount(found: NamedAccount | undefined) {
  return found ? { email: found.email, role: found.role, erased: found.erased } : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Row = {
  id: string;
  action: string;
  actor_id: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
};

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: {
            type: "string",
          },
          actor: {
            type: ["null", "object"],
            properties: {
              email: {
                type: ["null", "string"],
              },
              erased: {
                type: "boolean",
              },
              role: {
                type: "string",
              },
            },
          },
          actorId: {
            type: "string",
          },
          createdAt: {
            type: "string",
          },
          details: {
            type: "string",
          },
          id: {
            type: "string",
          },
          target: {
            type: ["null", "object"],
            properties: {
              email: {
                type: ["null", "string"],
              },
              erased: {
                type: "boolean",
              },
              role: {
                type: "string",
              },
            },
          },
          targetId: {
            type: ["null", "string"],
          },
        },
      },
    },
    hasMore: {
      type: "boolean",
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_view_audit");
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().toLowerCase();
  // TASK-215 (audit A-17): a URL carries ids and codes, never what a person typed — the search is
  // an account's id or part of an action's name (a code), and anything else is refused rather than
  // carried in the URL into proxies and access logs.
  if (q !== "" && !UUID.test(q) && !/^[a-z_]{1,64}$/.test(q)) {
    return apiError("request.invalid_value", {
      params: { field: "q", allowed: ["user_id", "action"] },
      request,
    });
  }
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

  // Every actor and target of the page, named in one read (N-63).
  const accounts = await namedAccounts(rows.flatMap((r) => [r.actor_id, r.target_id]));
  const locale = negotiateLocale(request.headers.get("accept-language"));
  const entries = rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorId: row.actor_id,
    targetId: row.target_id,
    actor: shownAccount(row.actor_id ? accounts.get(row.actor_id) : undefined),
    target: shownAccount(row.target_id ? accounts.get(row.target_id) : undefined),
    // The platform's words in its details — a run's reason, a change's note: a catalog key and
    // values (TASK-209) — in the reader's language; codes, ids and a person's text as they are.
    details: JSON.stringify(renderRecordedDeep(row.details, locale)),
    createdAt: row.created_at.toISOString(),
  }));

  return NextResponse.json({
    entries,
    hasMore: entries.length === limit,
  });
}, GET_RESPONSE);
