/**
 * app/api/admin/per-account/route.ts — GET per-account feature blocks (Sprint 3c U6).
 *
 * Read-only view for the governance panel. Returns the current user_feature_restrictions
 * rows. Mutations flow through the AI plan → confirm → execute path
 * (handlers/restrictions.ts), not this route.
 *
 * Restrictions are the tenant's own data (ADR-053 D5): only the current tenant's are listed.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { withTenantTx } from "@/platform/data";
import { internalError } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";
import { namedAccounts } from "@/platform/admin/account-names";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_account_restrictions");
  if (denied) return denied;

  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{
        user_id: string;
        feature: string;
        reason: string | null;
        created_by: string;
        created_at: Date;
      }>(
        `select user_id, feature, reason, created_by, created_at
           from user_feature_restrictions
          order by created_at desc
          limit 200`
      )
    );
    // The blocked account and who blocked it, by address (TASK-202, N-63).
    const accounts = await namedAccounts(rows.flatMap((r) => [r.user_id, r.created_by]));
    const named = (id: string) => {
      const found = accounts.get(id);
      return found ? { email: found.email, erased: found.erased } : null;
    };
    return NextResponse.json({
      restrictions: rows.map((r) => ({
        ...r,
        created_at: r.created_at.toISOString(),
        user: named(r.user_id),
        created_by_account: named(r.created_by),
      })),
    });
  } catch (error) {
    return internalError(error, { request, context: "Admin per-account query failed" });
  }
});
