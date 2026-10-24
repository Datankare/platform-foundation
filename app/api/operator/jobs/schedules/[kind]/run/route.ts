/**
 * app/api/operator/jobs/schedules/[kind]/run/route.ts — run a recurring job now
 * (operators only, ADR-056 D3)
 *
 * POST → { result: { enqueued, report } }
 *   Recorded first; then the kind is enqueued for every active tenant (or the platform) and
 *   what fits in a short budget runs inside this request. The rest runs on the next tick.
 *   Its schedule is not moved.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { runNow } from "@/platform/jobs/operator";
import { jobsResponse } from "@/platform/jobs/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

/** Long enough for RUN_NOW_BUDGET_MS and the answer. */
export const maxDuration = 60;

type Params = { params: Promise<{ kind: string }> };

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { kind } = await params;
  try {
    return jobsResponse(await runNow(guard.admin, kind), request);
  } catch (error) {
    return internalError(error, { request, context: "Run now failed" });
  }
});
