/**
 * app/api/account/age/route.ts — Record the signed-in account's date of birth, once (X-16)
 *
 * POST { dateOfBirth: "YYYY-MM-DD" }. For an account whose age was never recorded — one made
 * before the platform asked at sign-up, through single sign-on, or whose sign-up record failed —
 * the consent gate refuses every consent-gated feature until this is called. An age is recorded
 * once: a second declaration (a child re-declaring as an adult) answers
 * account.age_already_recorded and changes nothing. A child's account then waits for parental
 * consent; the record is written before the change (recordAgeVerification).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireActorWithStatus } from "@/platform/auth/actor-guard";
import { parseDeclaredBirthDate, recordAgeVerification } from "@/platform/auth/coppa";
import { isUnder13Unavailable } from "@/platform/auth/age";
import { apiError, readJsonBody, type InputSchemaNode } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const AGE_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    dateOfBirth: { type: "string" },
  },
};

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const guard = await requireActorWithStatus(request, "update_profile", {
    allowGuests: false,
  });
  if (guard.error) return guard.error;
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_ACCOUNT, {
    actorId: guard.actor.id,
  });
  if (limited) return limited;

  const read = await readJsonBody(request, AGE_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const { dateOfBirth } = read.body as { dateOfBirth?: unknown };
  const evaluation = parseDeclaredBirthDate(dateOfBirth);
  if (!evaluation || typeof dateOfBirth !== "string") {
    return apiError("request.invalid_value", {
      params: {
        field: "dateOfBirth",
        allowed: ["past_birth_date"],
        expected: "past_birth_date",
      },
      request,
    });
  }

  // TASK-181: an under-13 date is not recorded until parental consent ships (Batch 4).
  if (isUnder13Unavailable(evaluation)) {
    return apiError("account.child_accounts_unavailable", { request });
  }

  const recorded = await recordAgeVerification(guard.actor.id, dateOfBirth);
  if (!recorded.success) {
    if (recorded.error === "audit unavailable") {
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    }
    if (recorded.errorCode === "account.age_already_recorded") {
      return apiError("account.age_already_recorded", { request });
    }
    return apiError("service.unavailable", { params: { service: "accounts" }, request });
  }
  return NextResponse.json({
    success: true,
    requiresParentalConsent: evaluation.requiresParentalConsent,
    contentRatingLevel: evaluation.contentRatingLevel,
  });
});
