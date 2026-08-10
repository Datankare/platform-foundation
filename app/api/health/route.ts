/**
 * app/api/health/route.ts — Liveness and dependency health
 *
 * Runs every registered health probe and reports the aggregate. Before TASK-057 this
 * returned a literal `status: "ok"` without checking anything, which is worse than having no
 * endpoint: a load balancer believes it.
 *
 * OWASP A05 — the response carries probe NAMES and STATUSES only, never detail. This route
 * is unauthenticated, and a detail like "Supabase returned 401" tells an anonymous caller
 * our credentials are broken, while a timeout on the LLM probe tells them which provider we
 * use and that it is reachable from our network. Detail goes to the configured ErrorReporter
 * — an interface, so a consumer running Datadog or Bugsnag receives it there.
 */

import { NextResponse } from "next/server";
import { logger, generateRequestId } from "@/lib/logger";
import { tryGetObservability } from "@/platform/observability";

/** Withheld-detail notice, so a caller knows detail exists and where it went. */
const DETAIL_NOTICE =
  "Probe detail is withheld from unauthenticated callers (OWASP A05) and sent to the " +
  "configured error reporter. Correlate using requestId.";

export async function GET() {
  const requestId = generateRequestId();
  const observability = tryGetObservability();

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
        requestId,
        probeCount: 0,
        checks: [],
        detail: "Observability is not initialized; no probe could be run.",
      },
      { status: 503 }
    );
  }

  const report = await observability.health.check();

  // A registry with no probes reports healthy by definition (worstStatus of an empty list).
  // That is the same lie in a new place unless it is visible, so it is both logged and
  // carried in the payload as probeCount.
  if (report.checks.length === 0) {
    logger.warn("Health check ran with no registered probes", {
      requestId,
      route: "/api/health",
    });
  }

  for (const check of report.checks) {
    if (check.status === "unhealthy") {
      // error level, because the logger's production default is `error` — a warn here
      // would be invisible in exactly the environment that needs it.
      logger.error("Health probe unhealthy", {
        requestId,
        route: "/api/health",
        probe: check.name,
        error: check.detail ?? "no detail",
      });
      observability.errors.captureError(
        new Error(
          `Health probe '${check.name}' is unhealthy: ${check.detail ?? "no detail"}`
        ),
        {
          tags: { probe: check.name, route: "/api/health" },
          extra: { requestId, checkedAt: check.checkedAt },
        }
      );
    } else if (check.status === "degraded") {
      logger.warn("Health probe degraded", {
        requestId,
        route: "/api/health",
        probe: check.name,
        detail: check.detail ?? "no detail",
      });
    }
  }

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
      version: report.version,
      timestamp: report.timestamp,
      requestId,
      probeCount: report.checks.length,
      checks: report.checks.map((c) => ({
        name: c.name,
        status: c.status,
        checkedAt: c.checkedAt,
      })),
      ...(report.status === "healthy" ? {} : { detail: DETAIL_NOTICE }),
    },
    { status: httpStatus }
  );
}
