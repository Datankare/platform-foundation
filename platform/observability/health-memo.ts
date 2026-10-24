/**
 * platform/observability/health-memo.ts — what the health routes remember between requests
 * (./readiness.ts): the shared probe run, each probe's last reported status, the last readiness
 * answer. A globalThis singleton (ADR-032), reset with the observability state.
 *
 * @module platform/observability
 */

import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import type { HealthReport, HealthStatus } from "./types";

export interface HealthMemo {
  /** Per health registry, per timeout: the run in flight or the last answer, and when it began. */
  runs: WeakMap<object, Map<number, { at: number; report: Promise<HealthReport> }>>;
  /** Each probe's last reported status, so problems are reported on change only. */
  readonly probes: Map<string, HealthStatus>;
  /** The last readiness answer (for logging "not ready" on change only). */
  ready: boolean | null;
}

const MEMO_KEY = "platform.observability.healthMemo";
const fresh = (): HealthMemo => ({ runs: new WeakMap(), probes: new Map(), ready: null });

export function healthMemo(): HealthMemo {
  return getSingleton<HealthMemo>(MEMO_KEY, fresh);
}

/** Forget the shared answer only, as if HEALTH_CACHE_MS had passed (tests). */
export function expireHealthCache(): void {
  healthMemo().runs = new WeakMap();
}

/** Forget the shared answer and the reported states (tests; resetObservability). */
export function resetHealthCache(): void {
  setSingleton<HealthMemo>(MEMO_KEY, fresh());
}
