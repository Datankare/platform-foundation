/**
 * platform/observability/alert.ts — An operational alert: something a person must look at
 *
 * One call does the three things an alert needs: a structured error log line (what log-based
 * alerting rules match on: `alert` set), a metric event (`alert.<name>`, counted on dashboards),
 * and an error report (paged, when error reporting is configured). Best effort: an alert never
 * fails the work that raised it.
 *
 * Raised for: an approved run whose outcome is unknown (indeterminate, review 11 H-1), a run's
 * completion that conflicted with its claim (H-1), an agent's power reduced without a second
 * admin, and the emergency suspension of every agent (M-2).
 *
 * @module platform/observability
 */

import { logger } from "@/lib/logger";
import { getSingleton, hasSingleton } from "@/platform/kernel/singleton";
import type { ErrorReporter, MetricsSink } from "./types";
import { OBSERVABILITY_STATE_KEY } from "./state-key";

export interface Alert {
  /** A stable dotted name, e.g. "approvals.indeterminate". */
  readonly name: string;
  /** What happened and what to do, for a person. */
  readonly message: string;
  /** Short identifying values (ids, labels); never a secret or a personal address. */
  readonly tags?: Record<string, string>;
  /** How many (default 1). */
  readonly count?: number;
}

/** Raise `alert`: log it, count it, report it. Never throws. */
export function raiseAlert(alert: Alert): void {
  const tags = alert.tags ?? {};
  try {
    logger.error(alert.message, { alert: alert.name, ...tags, count: alert.count ?? 1 });
  } catch {
    // A logger failure is not the caller's.
  }
  // The observability state is read from its singleton, not through the layer's barrel: the
  // modules that raise alerts (the action pipeline's adapters, the approval jobs) are loaded early
  // and widely, and must not pull in the whole observability layer with them.
  try {
    if (!hasSingleton(OBSERVABILITY_STATE_KEY)) return;
    const obs = getSingleton<{ metrics: MetricsSink; errors: ErrorReporter }>(
      OBSERVABILITY_STATE_KEY,
      () => {
        throw new Error("unreachable");
      }
    );
    obs.metrics.record({
      name: `alert.${alert.name}`,
      timestamp: new Date().toISOString(),
      values: { count: alert.count ?? 1 },
      tags,
    });
    obs.errors.captureMessage(`[${alert.name}] ${alert.message}`, "error", { tags });
  } catch {
    // Best effort.
  }
}
