/**
 * app/api/account/export/route.ts — The signed-in user's copy of their data (GDPR Article 15;
 * audit X-15)
 *
 * GET. Every platform table that holds the user's data (platform/auth/user-data.ts), their
 * profile, their audit trail and every app module's data, as one JSON document. Requires
 * `can_export_data`. Complete or not at all: when any part cannot be read the route answers 503
 * and discloses nothing (RR-23); one of more than EXPORT_MAX_ROWS rows answers 413
 * account.export_too_large — never a cut-off copy (review 7 M2). The export is recorded before it
 * is returned (data_exported).
 * At most ten an hour per account.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireActor, requirePermission } from "@/platform/auth/middleware";
import { EXPORT_TOO_LARGE, exportUserData } from "@/platform/auth/data-export";
import { EXPORT_MAX_ROWS } from "@/platform/auth/user-data";
import { apiError } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { logger } from "@/lib/logger";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL);
  if (limited) return limited;
  const guard = await requireActor(request, { allowGuests: false, privileged: true });
  if (guard.error) return guard.error;
  if (guard.actor.kind !== "user") return apiError("auth.sign_in_required", { request });
  const { actor } = guard;
  const perAccount = await enforceRateLimit(request, DEFAULT_RULES.AUTH_ACCOUNT, {
    actorId: actor.id,
  });
  if (perAccount) return perAccount;
  const permitted = await requirePermission(actor.user.sub, "can_export_data");
  if (permitted.error) return permitted.error;

  const { data, errors } = await exportUserData(actor.id);
  if (errors.length > 0) {
    if (errors.includes("users: no live user row")) {
      return apiError("account.not_found", { request });
    }
    // More rows than one export holds: refused whole, never cut off (review 7 M2).
    if (errors.includes(EXPORT_TOO_LARGE)) {
      return apiError("account.export_too_large", {
        params: { limit: EXPORT_MAX_ROWS },
        request,
      });
    }
    logger.error("Data export not given: a part could not be read", {
      userId: actor.id,
      errorCount: errors.length,
      route: "app/api/account/export",
    });
    return apiError("service.unavailable", {
      params: { service: errors.includes("audit unavailable") ? "audit" : "export" },
      request,
    });
  }
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="my-data.json"',
    },
  });
});
