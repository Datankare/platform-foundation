/**
 * app/api/health/route.ts — the combined health report (kept for existing monitors)
 *
 * New monitors use the two questions separately (ADR-056 D4, ADR-055 D5):
 *   GET /api/health/live    the process answers — for restarts
 *   GET /api/health/ready   boot completed and the required dependencies answer — for routing
 *
 * This route answers as it always has — `status` healthy | degraded | unhealthy, 503 only when
 * unhealthy, `checks` with each probe's name, status and time, `probeCount`, `version`, `commit`
 * — with two changes made by ADR-056 D4:
 *   - each check says whether it is `required`; an unhealthy optional probe (realtime, a
 *     module's provider such as song identification) now makes the report degraded (200), not
 *     unhealthy (503). Required probes are the database (when the deployment has one) and the
 *     selected cache;
 *   - `ready` and `boot` say what /api/health/ready would answer (`ready` is false while the
 *     instance is stopping — `draining`, ADR-055 D5 — though this route keeps its status code).
 *
 * Before TASK-057 this returned a literal `status: "ok"` without checking anything, which is
 * worse than having no endpoint: a load balancer believes it.
 *
 * Unauthenticated and unthrottled, so the probes run at most once per HEALTH_CACHE_MS however
 * many callers there are (one shared answer, single flight), and a probe's detail is reported
 * when its state changes, not per request (platform/observability/readiness.ts).
 *
 * OWASP A05 — the response carries probe NAMES and STATUSES only, never detail. This route
 * is unauthenticated, and a detail like "Supabase returned 401" tells an anonymous caller
 * our credentials are broken, while a timeout on the LLM probe tells them which provider we
 * use and that it is reachable from our network. Detail goes to the configured ErrorReporter
 * — an interface, so a consumer running Datadog or Bugsnag receives it there.
 *
 * `commit` (ADR-050 D6, TASK-105): the git commit this deployment was built from, so the
 * deployed smoke test can prove which code is live. Reported on every path, healthy or not —
 * "what is running" matters most when it is broken. Null outside a hosted build.
 */

import { NextResponse } from "next/server";
import { logger, generateRequestId } from "@/lib/logger";
import { tryGetObservability } from "@/platform/observability";
import { getBootState } from "@/platform/observability/boot";
import { deployedCommit } from "@/platform/observability/deployment";
import { isDraining } from "@/platform/observability/shutdown";
import {
  cachedHealthCheck,
  reportProbeProblems,
} from "@/platform/observability/readiness";
import { tenantRoute } from "@/platform/tenancy/route";

export { deployedCommit };

/** Per-probe bound for this route (the registry's default). */
const HEALTH_TIMEOUT_MS = 5_000;

/** Withheld-detail notice, so a caller knows detail exists and where it went. */
const DETAIL_NOTICE =
  "Probe detail is withheld from unauthenticated callers (OWASP A05) and sent to the " +
  "configured error reporter. Correlate using requestId.";

export const GET = tenantRoute(async function GET() {
  const requestId = generateRequestId();
  const observability = tryGetObservability();
  const boot = getBootState().phase;

  // Fail closed. If initObservability() never ran we cannot know the state of anything,
  // and "we cannot know" is not "healthy" — reporting ok here is the defect being fixed.
  if (!observability) {
    logger.error("Health check failed — observability not initialized", {
      requestId,
      route: "/api/health",
      status: 503,
    });
    return NextResponse.json(
      {
        status: "unhealthy",
        ready: false,
        boot,
        commit: deployedCommit(),
        requestId,
        probeCount: 0,
        checks: [],
        detail: "Observability is not initialized; no probe could be run.",
      },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  const report = await cachedHealthCheck(observability.health, HEALTH_TIMEOUT_MS);

  // A registry with no probes reports healthy by definition (worstStatus of an empty list).
  // That is the same lie in a new place unless it is visible, so it is both logged and
  // carried in the payload as probeCount.
  if (report.checks.length === 0) {
    logger.warn("Health check ran with no registered probes", {
      requestId,
      route: "/api/health",
    });
  }
  reportProbeProblems(report, { requestId, route: "/api/health" });

  // Degraded stays 200: the service is serving. Only unhealthy takes it out of rotation.
  const httpStatus = report.status === "unhealthy" ? 503 : 200;

  logger.info("Health check", {
    requestId,
    route: "/api/health",
    status: httpStatus,
    health: report.status,
    probeCount: report.checks.length,
  });

  return NextResponse.json(
    {
      status: report.status,
      ready: !isDraining() && boot === "completed" && report.status !== "unhealthy",
      boot,
      draining: isDraining(),
      version: report.version,
      commit: deployedCommit(),
      timestamp: report.timestamp,
      requestId,
      probeCount: report.checks.length,
      checks: report.checks.map((c) => ({
        name: c.name,
        status: c.status,
        required: c.required !== false,
        checkedAt: c.checkedAt,
      })),
      ...(report.status === "healthy" ? {} : { detail: DETAIL_NOTICE }),
    },
    { status: httpStatus, headers: { "cache-control": "no-store" } }
  );
});
