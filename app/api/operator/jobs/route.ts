/**
 * app/api/operator/jobs/route.ts — the Jobs console's view (operators only, ADR-056 D2/D3)
 *
 * GET → { schedules: [...], deadLetters: [...] }
 *   schedules     every recurring job: what it does, who declared it, whether it runs for each
 *                 tenant or the platform, its governed enabled flag and interval (with bounds),
 *                 its last run, its last outcome and how many of its jobs are queued, running
 *                 and dead
 *   deadLetters   dead-lettered jobs, newest first, with the platform's own wording of why
 *
 * Read-only. Changing a schedule, running one now, replaying or discarding a dead job are the
 * routes below this one.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { describeSchedules, listDeadLetters } from "@/platform/jobs/operator";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  try {
    const [schedules, deadLetters] = await Promise.all([
      describeSchedules(),
      listDeadLetters(),
    ]);
    return NextResponse.json({ schedules, deadLetters });
  } catch (error) {
    return internalError(error, { request, context: "Jobs view failed" });
  }
});
