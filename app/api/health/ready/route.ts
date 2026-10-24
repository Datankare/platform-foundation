/**
 * app/api/health/ready/route.ts — readiness: this instance can serve (ADR-056 D4, TASK-142)
 *
 * 200 when boot completed and every required dependency answers — the database (when the
 * deployment has one) and the selected cache; `status` is "degraded" when an optional probe
 * (realtime, a module's provider) is not healthy, still 200, so one dependency's blip does not
 * take every instance out of rotation. 503 otherwise, with `boot` and `bootStep` saying whether
 * and where boot stopped — and 503 with `draining: true` once the instance is stopping (SIGTERM
 * received, ADR-055 D5), so the load balancer takes it out while requests in flight finish.
 *
 * Each probe is bounded (READINESS_TIMEOUT_MS) and they run in parallel; one run answers every
 * request for HEALTH_CACHE_MS (single flight), and problems are logged and reported when they
 * change, not per request — the route is unauthenticated and unthrottled. Names and statuses
 * only: detail goes to the error reporter, correlated by requestId (OWASP A05).
 *
 * GET → { status: "ready" | "degraded" | "unready", ready, boot, bootStep, draining, version, commit,
 *         timestamp, requestId, checks: [{ name, status, required, checkedAt }] }
 */

import { NextResponse } from "next/server";
import { logger, generateRequestId } from "@/lib/logger";
import { deployedCommit } from "@/platform/observability/deployment";
import {
  checkReadiness,
  readinessChanged,
  reportProbeProblems,
} from "@/platform/observability/readiness";
import { tenantRoute } from "@/platform/tenancy/route";
import { PLATFORM_VERSION } from "@/platform/version";

export const GET = tenantRoute(async function GET() {
  const requestId = generateRequestId();
  const readiness = await checkReadiness();
  if (readiness.report) {
    reportProbeProblems(readiness.report, { requestId, route: "/api/health/ready" });
  }
  const changed = readinessChanged(readiness.ready);
  if (changed && !readiness.ready && !readiness.draining) {
    logger.error("Not ready", {
      requestId,
      route: "/api/health/ready",
      boot: readiness.boot,
      bootStep: readiness.bootStep ?? "none",
      unhealthy: readiness.checks
        .filter((c) => c.status === "unhealthy")
        .map((c) => c.name)
        .join(","),
    });
  }
  return NextResponse.json(
    {
      status: readiness.status,
      ready: readiness.ready,
      boot: readiness.boot,
      bootStep: readiness.bootStep,
      draining: readiness.draining,
      version: PLATFORM_VERSION,
      commit: deployedCommit(),
      timestamp: new Date().toISOString(),
      requestId,
      checks: readiness.checks,
    },
    { status: readiness.ready ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
});
