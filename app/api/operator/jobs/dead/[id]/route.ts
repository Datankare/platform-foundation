/**
 * app/api/operator/jobs/dead/[id]/route.ts — act on one dead-lettered job
 * (operators only, ADR-056 D2)
 *
 * POST { action: "replay" | "discard" }
 *   replay    queued again from its first attempt (a second replay finds it not dead: 409)
 *   discard   removed for good
 * Recorded in the audit log before it takes effect. 404 jobs.not_found, 409 jobs.not_dead.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { apiError, internalError, readJsonObject } from "@/platform/errors";
import { discardDeadJob, replayDeadJob } from "@/platform/jobs/operator";
import { jobsResponse } from "@/platform/jobs/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

type Params = { params: Promise<{ id: string }> };

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const { action } = read.body as Record<string, unknown>;
  if (action !== "replay" && action !== "discard") {
    return apiError("request.invalid_value", {
      params: { field: "action", allowed: ["replay", "discard"] },
      request,
    });
  }
  try {
    const result =
      action === "replay"
        ? await replayDeadJob(guard.admin, id)
        : await discardDeadJob(guard.admin, id);
    return jobsResponse(result, request);
  } catch (error) {
    return internalError(error, { request, context: "Dead-letter action failed" });
  }
});
