/**
 * app/api/operator/jobs/schedules/[kind]/route.ts — change one recurring job's schedule
 * (operators only, ADR-056 D3)
 *
 * PATCH { enabled: boolean, changeComment } | { intervalMinutes: number, changeComment }
 *   One setting per request: jobs.<kind>.enabled or jobs.<kind>.interval_minutes, the platform
 *   default, through the governed write — tier permission, validation (the interval's bounds),
 *   the audit record, history, two-person approval and dual control (turning off a safety duty
 *   needs a second operator). 200 applied, 202 held for approval.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { governedOutcomeResponse } from "@/platform/admin/config-http";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { setSchedule } from "@/platform/jobs/operator";
import { jobsResponse } from "@/platform/jobs/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

type Params = { params: Promise<{ kind: string }> };

export const PATCH = tenantRoute(async function PATCH(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { kind } = await params;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const { enabled, intervalMinutes, changeComment } = read.body as Record<
    string,
    unknown
  >;
  if (typeof changeComment !== "string" || changeComment.trim().length < 3) {
    return apiError("request.missing_fields", {
      params: { fields: ["changeComment"] },
      request,
    });
  }
  const one =
    (enabled !== undefined ? 1 : 0) + (intervalMinutes !== undefined ? 1 : 0) === 1;
  if (
    !one ||
    (enabled !== undefined && typeof enabled !== "boolean") ||
    (intervalMinutes !== undefined &&
      (typeof intervalMinutes !== "number" || !Number.isInteger(intervalMinutes)))
  ) {
    return apiError("request.invalid_body", { request });
  }
  try {
    const result = await setSchedule(guard.admin, kind, {
      ...(enabled !== undefined ? { enabled: enabled as boolean } : {}),
      ...(intervalMinutes !== undefined
        ? { intervalMinutes: intervalMinutes as number }
        : {}),
      changeComment: changeComment.trim(),
    });
    if (!result.ok) return jobsResponse(result, request);
    const [change] = result.value;
    return governedOutcomeResponse(
      change.outcome,
      change.key,
      enabled !== undefined ? enabled : intervalMinutes,
      request
    );
  } catch (error) {
    return internalError(error, { request, context: "Schedule change failed" });
  }
});
