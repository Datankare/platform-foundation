/**
 * platform/observability/readiness.ts — liveness and readiness are different questions
 * (ADR-056 D4, ADR-055 D5, TASK-142)
 *
 *   live    the process answers. Nothing else is asked, so a load balancer or orchestrator
 *           restarts only an instance that has truly stopped.
 *   ready   this instance can serve: its boot completed (./boot.ts) and every required
 *           dependency answers — the database (when the deployment has one) and the selected
 *           cache. Realtime and the modules' probes are optional: their failure reports
 *           "degraded", still ready, so one dependency's blip cannot take every instance out of
 *           rotation at once.
 *
 * An instance that is stopping (./shutdown.ts — SIGTERM received) is unready at once, without
 * asking any probe, so the load balancer takes it out of rotation while requests in flight finish.
 *
 * Every probe is bounded by the registry's per-probe timeout (READINESS_TIMEOUT_MS here), and
 * they run in parallel, so a readiness answer never takes much longer than that. What callers
 * are told is names and statuses: a probe's detail (an address, a provider's message) goes to
 * the log and the error reporter (reportProbeProblems), never into a response.
 *
 * Both health routes are unauthenticated and unthrottled (a load balancer calls them), so one
 * answer is shared for HEALTH_CACHE_MS (cachedHealthCheck): any number of callers in that window
 * — however many arrive at once — run the probes once (single flight). And a probe's problem is
 * reported when its state changes (healthy → unhealthy, and so on), not on every request: a
 * flood of requests to a broken instance sends one event to the error reporter, not one each.
 * Draining is read on every request, never from the cache. Liveness asks nothing and is not
 * cached.
 *
 * @module platform/observability
 */

import { logger } from "@/lib/logger";
import { getBootState, type BootPhase } from "./boot";
import { tryGetObservability } from "./index";
import { healthMemo as memo } from "./health-memo";
import { isDraining } from "./shutdown";
import type { HealthReport, HealthStatus } from "./types";

/** Per-probe bound for readiness: shorter than a load balancer's usual 5 s check timeout. */
export const READINESS_TIMEOUT_MS = 3_000;
/** How long one probe run answers every health request (single flight within it). */
export const HEALTH_CACHE_MS = 3_000;

export { resetHealthCache } from "./health-memo";

/**
 * The registry's report, shared: a run started less than HEALTH_CACHE_MS ago (finished or still
 * running) answers instead of a new one. A run that fails is not kept.
 */
export function cachedHealthCheck(
  health: { check(timeoutMs?: number): Promise<HealthReport> },
  timeoutMs: number,
  now: () => number = Date.now
): Promise<HealthReport> {
  const m = memo();
  let byTimeout = m.runs.get(health);
  if (!byTimeout) {
    byTimeout = new Map();
    m.runs.set(health, byTimeout);
  }
  const hit = byTimeout.get(timeoutMs);
  if (hit && now() - hit.at < HEALTH_CACHE_MS) return hit.report;
  const report = health.check(timeoutMs);
  const entry = { at: now(), report };
  byTimeout.set(timeoutMs, entry);
  report.catch(() => {
    if (byTimeout!.get(timeoutMs) === entry) byTimeout!.delete(timeoutMs);
  });
  return report;
}

/** Whether the readiness answer changed since the last call (first call: true when unready). */
export function readinessChanged(ready: boolean): boolean {
  const m = memo();
  const changed = m.ready === null ? !ready : m.ready !== ready;
  m.ready = ready;
  return changed;
}

export type ReadinessStatus = "ready" | "degraded" | "unready";

export interface ReadinessCheck {
  readonly name: string;
  readonly status: HealthStatus;
  readonly required: boolean;
  readonly checkedAt: string;
}

export interface Readiness {
  readonly status: ReadinessStatus;
  readonly ready: boolean;
  readonly boot: BootPhase;
  /** The boot step that has not completed (starting or failed); null once booted. */
  readonly bootStep: string | null;
  /** The instance is stopping (SIGTERM received): unready whatever the probes say. */
  readonly draining: boolean;
  readonly checks: readonly ReadinessCheck[];
  /** The probe report itself, for the caller's logging (never returned as is). */
  readonly report: HealthReport | null;
}

/** Ask every registered probe and decide. Never throws. */
export async function checkReadiness(
  timeoutMs: number = READINESS_TIMEOUT_MS
): Promise<Readiness> {
  const boot = getBootState();
  const observability = tryGetObservability();
  const bootStep = boot.phase === "completed" ? null : boot.step;
  const unready = (): Readiness => ({
    status: "unready",
    ready: false,
    boot: boot.phase,
    bootStep,
    draining: isDraining(),
    checks: [],
    report: null,
  });
  // A stopping instance is out of rotation whatever its dependencies say (ADR-055 D5).
  if (isDraining() || !observability) return unready();
  let report: HealthReport;
  try {
    report = await cachedHealthCheck(observability.health, timeoutMs);
  } catch {
    // HealthRegistry turns every probe failure into a result; this is a registry defect.
    return unready();
  }
  // A stop that began while the probes ran wins: the answer must not let traffic back in.
  const draining = isDraining();
  const ready = !draining && boot.phase === "completed" && report.status !== "unhealthy";
  const status: ReadinessStatus = !ready
    ? "unready"
    : report.status === "degraded"
      ? "degraded"
      : "ready";
  return {
    status,
    ready,
    boot: boot.phase,
    bootStep,
    draining,
    checks: report.checks.map((c) => ({
      name: c.name,
      status: c.status,
      required: c.required !== false,
      checkedAt: c.checkedAt,
    })),
    report,
  };
}

/**
 * Log each probe whose status changed since it was last reported, and send a probe that became
 * unhealthy to the error reporter — the only places a probe's detail goes. Called per request;
 * a probe that stays unhealthy is reported once, and again only after it recovered.
 */
export function reportProbeProblems(
  report: HealthReport,
  context: { readonly requestId: string; readonly route: string }
): void {
  const observability = tryGetObservability();
  const seen = memo().probes;
  for (const check of report.checks) {
    const before = seen.get(check.name) ?? "healthy";
    if (check.status === before) continue;
    seen.set(check.name, check.status);
    if (check.status === "unhealthy") {
      // error level: the logger's production default is `error`, so a warn would be invisible
      // in exactly the environment that needs it.
      logger.error("Health probe unhealthy", {
        ...context,
        probe: check.name,
        required: check.required !== false,
        was: before,
        error: check.detail ?? "no detail",
      });
      observability?.errors.captureError(
        new Error(
          `Health probe '${check.name}' is unhealthy: ${check.detail ?? "no detail"}`
        ),
        {
          tags: { probe: check.name, route: context.route },
          extra: { requestId: context.requestId, checkedAt: check.checkedAt },
        }
      );
    } else if (check.status === "degraded") {
      logger.warn("Health probe degraded", {
        ...context,
        probe: check.name,
        was: before,
        detail: check.detail ?? "no detail",
      });
    } else {
      logger.warn("Health probe recovered", {
        ...context,
        probe: check.name,
        was: before,
      });
    }
  }
}
