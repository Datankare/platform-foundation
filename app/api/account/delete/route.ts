/**
 * app/api/account/delete/route.ts — The signed-in user erases their own account (GDPR
 * Article 17; audit X-15)
 *
 * POST { confirm: "DELETE" }. Requires `can_delete_account`. The account is erased at once:
 * recorded first, the profile anonymised and the account closed (it can no longer sign in or be
 * re-created from the same identity; a banned address keeps its ban, A-11), every app module's
 * soft delete run, and the erasure scheduled — after the retention period the retention job
 * purges every platform table that holds the user's data (platform/auth/user-data.ts). The
 * sign-in identity is deleted by the erasure itself, with the provider's administrative
 * credentials (TASK-193: the same pipeline as an admin or retention erasure), and the session
 * cookies cleared.
 *
 * An erasure that did not complete answers 503 and says so; one whose identity is not deleted yet
 * answers 200 with `identityDeleted: false` (the account is closed either way, the identity can
 * no longer reach it, and the job retries its deletion until done). At most ten an hour per account.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireActor, requirePermission } from "@/platform/auth/middleware";
import { softDeleteUser } from "@/platform/auth/gdpr-deletion";
import { clearSessionCookies } from "@/platform/auth/auth-response";
import { apiError, readJsonObject } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { logger } from "@/lib/logger";

export const POST = tenantRoute(async function POST(request: NextRequest) {
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
  const permitted = await requirePermission(actor.user.sub, "can_delete_account");
  if (permitted.error) return permitted.error;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  if (read.body.confirm !== "DELETE") {
    return apiError("request.invalid_value", {
      params: { field: "confirm", allowed: ["DELETE"] },
      request,
    });
  }

  const erased = await softDeleteUser(actor.id, actor.id);
  if (!erased.success) {
    logger.error("Account erasure did not complete", {
      userId: actor.id,
      errors: erased.errors,
      route: "app/api/account/delete",
    });
    if (erased.errors.some((e) => e.startsWith("users: no such user"))) {
      return apiError("account.not_found", { request });
    }
    return apiError("service.unavailable", {
      params: {
        service: erased.errors.includes("audit unavailable") ? "audit" : "accounts",
      },
      request,
    });
  }

  // The sign-in identity was deleted by the erasure itself, with the provider's administrative
  // credentials (TASK-193, audit B-8/D-9) — the same step an admin or retention erasure runs; one
  // not deleted yet is recorded on the erasure and retried by the gdpr.retention-purge job until
  // it is (before, this route tried once with the user's token and only logged a failure).
  const identityDeleted = !(erased.externalPending ?? []).includes("identity-provider");
  if (!identityDeleted) {
    logger.error(
      "Account erased; its sign-in identity is not deleted yet (retried by the job)",
      {
        userId: actor.id,
        route: "app/api/account/delete",
      }
    );
  }

  const response = NextResponse.json({ success: true, identityDeleted });
  clearSessionCookies(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
});
