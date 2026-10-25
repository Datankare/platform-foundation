/**
 * platform/observability/metric-event.ts — One metric event, recorded without loading the layer
 *
 * For a light module that counts something on dashboards but is not an alert (the shared-cache
 * stamp reader counts reads lost to event-loop lag, review 14 M-2): the observability state is
 * read from its singleton, as alert.ts reads it, so the caller never pulls in the whole
 * observability layer. Best effort: a metric never fails the work that records it, and before
 * observability is initialised nothing is recorded.
 *
 * @module platform/observability
 */

import { getSingleton, hasSingleton } from "@/platform/kernel/singleton";
import type { MetricsSink } from "./types";
import { OBSERVABILITY_STATE_KEY } from "./state-key";

/** Record the metric `name` with `values` and `tags`. Never throws. */
export function recordMetricEvent(
  name: string,
  values: Record<string, number>,
  tags: Record<string, string> = {}
): void {
  try {
    if (!hasSingleton(OBSERVABILITY_STATE_KEY)) return;
    const obs = getSingleton<{ metrics: MetricsSink }>(OBSERVABILITY_STATE_KEY, () => {
      throw new Error("unreachable");
    });
    obs.metrics.record({ name, timestamp: new Date().toISOString(), values, tags });
  } catch {
    // Best effort.
  }
}
