/**
 * platform/jobs/schedule-probe.ts — readiness says when the timed duties have stopped running
 * (ADR-056 D4, D6)
 *
 * A deployment whose ticks never arrive — no CRON_SECRET, a Vercel plan without the cron, no
 * worker beside the container — boots, answers ready and runs no duty: escalations stay over
 * their SLA, erasures past their retention are not completed, and nothing says so. This probe
 * does: it is an optional probe (registered "degraded only" at boot, instrumentation.ts), so a
 * stale schedule makes readiness and /api/health "degraded" — still serving, never unready, since
 * taking every instance out of rotation would not make a tick arrive — and names the kinds in the
 * probe's detail (the log and the error reporter, never the response).
 *
 * A recurring kind that is on is stale when
 *   - it has run before, and its last slot is older than twice its interval (at least
 *     STALE_SCHEDULE_GRACE_MS) — a tick takes a due slot on its first pass, so two intervals
 *     without one means no tick has run; or
 *   - it has never run, STALE_SCHEDULE_GRACE_MS after this instance started (a first slot is due
 *     at once, so the first tick takes it) or after it was seen turned on.
 *
 * The answer is cached for PROBE_CACHE_MS: the schedules change on the scale of minutes.
 *
 * @module platform/jobs
 */

import type { HealthCheckResult, HealthProbe } from "@/platform/observability/types";
import { runWithoutTenant } from "@/platform/tenancy/context";
import { listScheduledJobs } from "./registry";
import { scheduleEnabled, scheduleInterval } from "./runner";
import { getJobStore } from "./store";
import type { JobStore } from "./types";

/** How long a never-run (or newly turned on) schedule may wait for its first tick. */
export const STALE_SCHEDULE_GRACE_MS = 15 * 60_000;
/** How long one answer is reused. */
const PROBE_CACHE_MS = 60_000;

export interface ScheduleFreshnessOptions {
  readonly store?: () => JobStore;
  /** The clock (epoch ms). */
  readonly now?: () => number;
  /** When this instance started watching (default: when the probe was created). */
  readonly since?: number;
  /** How long an answer is reused (default 60 s; 0 in tests). */
  readonly cacheMs?: number;
}

/** Per kind: when it was seen turned on, if it was seen off first. */
type Seen = Map<string, { enabled: boolean; enabledSince?: number }>;

/** The stale kinds, each with why. */
export async function staleSchedules(
  store: JobStore,
  now: number,
  since: number,
  seen: Seen = new Map()
): Promise<string[]> {
  const times = new Map((await store.listScheduleTimes()).map((t) => [t.kind, t]));
  return runWithoutTenant(async () => {
    const stale: string[] = [];
    for (const def of listScheduledJobs()) {
      const enabled = await scheduleEnabled(def.kind);
      const before = seen.get(def.kind);
      const enabledSince =
        enabled && before && !before.enabled ? now : before?.enabledSince;
      seen.set(def.kind, {
        enabled,
        ...(enabled && enabledSince !== undefined ? { enabledSince } : {}),
      });
      if (!enabled) continue;
      const last = times.get(def.kind)?.lastRunAt;
      if (!last) {
        const from = enabledSince ?? since;
        if (now - from > STALE_SCHEDULE_GRACE_MS) {
          stale.push(`${def.kind} has never run`);
        }
        continue;
      }
      const intervalMs = (await scheduleInterval(def)) * 60_000;
      const from = Math.max(Date.parse(last), enabledSince ?? -Infinity);
      const limit = Math.max(2 * intervalMs, STALE_SCHEDULE_GRACE_MS);
      if (now - from > limit) {
        stale.push(
          `${def.kind} last ran ${Math.round((now - Date.parse(last)) / 60_000)} min ago (every ${intervalMs / 60_000} min)`
        );
      }
    }
    return stale;
  });
}

/**
 * The probe: healthy while every enabled schedule is running; degraded, naming the stale kinds,
 * when one is not (or the schedules cannot be read).
 */
export function createScheduleFreshnessProbe(
  options: ScheduleFreshnessOptions = {}
): HealthProbe {
  const now = options.now ?? Date.now;
  const since = options.since ?? now();
  const cacheMs = options.cacheMs ?? PROBE_CACHE_MS;
  const store = options.store ?? getJobStore;
  const seen: Seen = new Map();
  let cached: { at: number; result: HealthCheckResult } | null = null;
  return {
    name: "job-schedules",
    async check(): Promise<HealthCheckResult> {
      const at = now();
      if (cached && at - cached.at < cacheMs) return cached.result;
      const started = Date.now();
      let result: HealthCheckResult;
      try {
        const stale = await staleSchedules(store(), at, since, seen);
        result = {
          name: "job-schedules",
          status: stale.length === 0 ? "healthy" : "degraded",
          latencyMs: Date.now() - started,
          detail:
            stale.length === 0
              ? "every enabled schedule is running"
              : `no tick has run these on time — is the job tick called (CRON_SECRET, the cron or the worker)? ${stale.join("; ")}`,
          checkedAt: new Date(at).toISOString(),
        };
      } catch (err) {
        result = {
          name: "job-schedules",
          status: "degraded",
          latencyMs: Date.now() - started,
          detail: `the schedules could not be read: ${err instanceof Error ? err.name : "error"}`,
          checkedAt: new Date(at).toISOString(),
        };
      }
      cached = { at, result };
      return result;
    },
  };
}
