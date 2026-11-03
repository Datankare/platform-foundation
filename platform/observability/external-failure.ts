/**
 * platform/observability/external-failure.ts — Record an external dependency's failure (TASK-197)
 *
 * The one call a provider makes when an external call fails: it returns the ExternalServiceError
 * to throw, after recording it —
 *
 *   - every failure: a metric event `external.failure` tagged with the service and the reason,
 *     so a dashboard shows a provider's failures by kind (audit D-5: Google and ACRCloud failures
 *     wrote a log line only);
 *   - a failure a person must fix (ALERTING_REASONS — a refused credential, an exhausted quota, a
 *     retired model): an alert (`external.<reason>`: log, metric, error report — ./alert.ts).
 *
 *   if (!res.ok) throw externalFailure("google-tts", classifyHttpFailure(res.status), …);
 *
 * Best effort and never throws: a recording failure is not the caller's. The message is for logs
 * only — the route answers `service.unavailable` with the service's id (platform/errors/respond).
 * Never pass a secret, a key or user content in the message.
 *
 * __tests__/external-failure-coverage.test.ts holds every external call site to this: each
 * `!response.ok` branch in a file that calls fetchWithTimeout reports through here (or raises an
 * alert itself), or is listed there with its reason.
 *
 * @module platform/observability
 */

import {
  ALERTING_REASONS,
  ExternalServiceError,
  type ExternalFailureReason,
} from "@/platform/errors/external-service";
import { raiseAlert } from "./alert";
import { getSingleton, hasSingleton } from "@/platform/kernel/singleton";
import { OBSERVABILITY_STATE_KEY } from "./state-key";
import type { MetricsSink } from "./types";

export {
  classifyHttpFailure,
  ExternalServiceError,
  isExternalServiceError,
  type ExternalFailureReason,
} from "@/platform/errors/external-service";

/** What an operator is told for each alerting reason. */
const ALERT_TEXT: Readonly<Partial<Record<ExternalFailureReason, string>>> = {
  credential:
    "refused the platform's credential (rotated, revoked, restricted or billing off): check the key in the deployment's settings and the credential register (docs/ENV_REFERENCE.md)",
  quota:
    "refused the call for quota or plan limits: raise the plan or quota, or wait for it to reset",
  model_retired:
    "answered that the model no longer exists: move MODEL_REGISTRY (platform/ai/types.ts) to a current model",
};

/** Record a metric without pulling in the observability barrel (as ./alert.ts does). */
function recordFailureMetric(tags: Record<string, string>): void {
  try {
    if (!hasSingleton(OBSERVABILITY_STATE_KEY)) return;
    const obs = getSingleton<{ metrics: MetricsSink }>(OBSERVABILITY_STATE_KEY, () => {
      throw new Error("unreachable");
    });
    obs.metrics.record({
      name: "external.failure",
      timestamp: new Date().toISOString(),
      values: { count: 1 },
      tags,
    });
  } catch {
    // Best effort.
  }
}

/**
 * One alert per cause (service and reason) per instance per ALERT_WINDOW_MS (TASK-197 review
 * round 1, L-1): a refused key fails every request, and an alert per request would bury the
 * page. The failures in between are counted, and the next alert carries the count. The metric is
 * still recorded for every failure.
 */
export const ALERT_WINDOW_MS = 10 * 60_000;
const ALERT_STATE_KEY = "platform.observability.external-alerts";

function alertState(): Map<string, { at: number; suppressed: number }> {
  return getSingleton(
    ALERT_STATE_KEY,
    () => new Map<string, { at: number; suppressed: number }>()
  );
}

/** Forget the alert windows (tests). */
export function resetExternalAlerts(): void {
  alertState().clear();
}

/** Record a failure that is already an ExternalServiceError (built elsewhere). Never throws. */
export function reportExternalFailure(
  err: ExternalServiceError,
  now: number = Date.now()
): void {
  const tags: Record<string, string> = { service: err.service, reason: err.reason };
  if (err.status !== undefined) tags.status = String(err.status);
  if (err.providerCode !== undefined) tags.providerCode = err.providerCode;
  recordFailureMetric(tags);
  if (!ALERTING_REASONS.has(err.reason)) return;
  try {
    const key = `${err.service}:${err.reason}`;
    const state = alertState();
    const prev = state.get(key);
    if (prev && now - prev.at < ALERT_WINDOW_MS) {
      prev.suppressed++;
      return;
    }
    const count = (prev?.suppressed ?? 0) + 1;
    state.set(key, { at: now, suppressed: 0 });
    raiseAlert({
      name: `external.${err.reason}`,
      message: `${err.service} ${ALERT_TEXT[err.reason] ?? "failed"}${
        count > 1 ? ` (${count} failures since the last alert)` : ""
      }`,
      tags,
      count,
    });
  } catch {
    // Best effort.
  }
}

/** Build, record and return the error to throw for an external call that failed. */
export function externalFailure(
  service: string,
  reason: ExternalFailureReason,
  message: string,
  details: { readonly status?: number; readonly providerCode?: string } = {}
): ExternalServiceError {
  const err = new ExternalServiceError(service, reason, message, details);
  reportExternalFailure(err);
  return err;
}

/**
 * The start of a failed answer's body, for classifying it (a 403 quota answer from a 403
 * credential one) — never for showing. Empty when it cannot be read.
 */
export async function readFailureText(res: {
  text?: () => Promise<string>;
}): Promise<string> {
  try {
    return typeof res.text === "function" ? (await res.text()).slice(0, 2000) : "";
  } catch {
    return "";
  }
}
