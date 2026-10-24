/**
 * platform/observability/in-flight.ts — work this instance has started and not finished
 * (ADR-055 D5)
 *
 * A stopping instance must not close its database pools under a request that is still using
 * them: the request would fail with a 500 for no reason of its own. Every API route handler is
 * counted here while it runs (platform/tenancy/route.ts wraps each in tenantRoute, a CI check
 * requires it), and so is a job handler the runner left running past its time
 * (platform/jobs/runner.ts). The shutdown handler (./shutdown.ts) waits for the count to reach
 * zero — up to its bound — before it closes anything.
 *
 * Imports only the singleton carrier: route bundles and instrumentation are separate module
 * copies (ADR-032) and must share one count.
 *
 * @module platform/observability
 */

import { getSingleton } from "@/platform/kernel/singleton";

interface InFlightState {
  active: number;
  readonly idle: Set<() => void>;
}

const KEY = "platform.observability.inFlight";
const state = (): InFlightState =>
  getSingleton<InFlightState>(KEY, () => ({ active: 0, idle: new Set() }));

/** Count one unit of work as started; the returned function ends it (calling it twice is a no-op). */
export function beginInFlight(): () => void {
  const s = state();
  s.active++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    s.active = Math.max(0, s.active - 1);
    if (s.active === 0) {
      for (const wake of [...s.idle]) wake();
    }
  };
}

/** Run `fn`, counted as in flight until it settles. */
export async function trackInFlight<T>(fn: () => Promise<T>): Promise<T> {
  const end = beginInFlight();
  try {
    return await fn();
  } finally {
    end();
  }
}

/** How much work is in flight now. */
export function inFlightCount(): number {
  return state().active;
}

/**
 * Resolve true once nothing is in flight, or false after `timeoutMs` if something still is.
 */
export function waitForIdle(timeoutMs: number): Promise<boolean> {
  const s = state();
  if (s.active === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      s.idle.delete(wake);
      resolve(true);
    };
    s.idle.add(wake);
    const timer = setTimeout(
      () => {
        s.idle.delete(wake);
        resolve(s.active === 0);
      },
      Math.max(0, timeoutMs)
    );
  });
}

/** Back to nothing in flight (tests only). */
export function resetInFlight(): void {
  const s = state();
  s.active = 0;
  for (const wake of [...s.idle]) wake();
}
