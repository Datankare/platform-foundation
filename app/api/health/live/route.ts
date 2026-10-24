/**
 * app/api/health/live/route.ts — liveness: the process answers (ADR-056 D4, ADR-055 D5)
 *
 * Asks nothing of any dependency — not the database, not the cache, not even whether boot
 * finished — so an orchestrator restarts only an instance that has truly stopped answering, and
 * never every instance because a shared dependency blinked. Readiness is /api/health/ready.
 *
 * GET → 200 { status: "live", version, commit, timestamp }
 */

import { NextResponse } from "next/server";
import { deployedCommit } from "@/platform/observability/deployment";
import { tenantRoute } from "@/platform/tenancy/route";
import { PLATFORM_VERSION } from "@/platform/version";

export const GET = tenantRoute(async function GET() {
  return NextResponse.json(
    {
      status: "live",
      version: PLATFORM_VERSION,
      commit: deployedCommit(),
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
});
