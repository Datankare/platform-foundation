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
import { apiError, readJsonObject } from "@/platform/errors";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const guard = await requireActorWithStatus(request, "update_profile", {
    allowGuests: false,
  });
  if (guard.error) return guard.error;
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_ACCOUNT, {
    actorId: guard.actor.id,
  });
  if (limited) return limited;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const { dateOfBirth } = read.body as { dateOfBirth?: unknown };
  const evaluation = parseDeclaredBirthDate(dateOfBirth);
  if (!evaluation || typeof dateOfBirth !== "string") {
    return apiError("request.invalid_value", {
      params: { field: "dateOfBirth", allowed: ["a past date of birth, YYYY-MM-DD"] },
      request,
    });
  }

  const recorded = await recordAgeVerification(guard.actor.id, dateOfBirth);
  if (!recorded.success) {
    if (recorded.error === "audit unavailable") {
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    }
    if (recorded.error?.startsWith("the age is already recorded")) {
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
