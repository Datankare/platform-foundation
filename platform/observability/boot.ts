/**
 * platform/observability/boot.ts — did this instance finish starting? (ADR-056 D4, ADR-055 D5)
 *
 * instrumentation.ts records each boot step: started, then completed — or failed, with the step
 * that failed. Readiness (/api/health/ready) reports an instance whose boot has not completed as
 * unready, and names the step, so an instance that kept running after a failed boot (outside
 * production, register() logs and carries on) is never taken for a healthy one. Only the step's
 * name and the time are kept: the error itself goes to the log, never to a probe's answer.
 *
 * ADR-032: the state is a globalThis singleton, so instrumentation and every route bundle read
 * the same one.
 *
 * @module platform/observability
 */

import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

export type BootPhase = "not_started" | "starting" | "completed" | "failed";

export interface BootState {
  readonly phase: BootPhase;
  /** The step running (starting) or that failed (failed). */
  readonly step: string | null;
  readonly at: string | null;
}

const KEY = "platform.observability.boot";
const initial: BootState = Object.freeze({ phase: "not_started", step: null, at: null });

const read = (): BootState => getSingleton<BootState>(KEY, () => initial);
const write = (next: BootState): void => {
  setSingleton<BootState>(KEY, Object.freeze(next));
};

/** Boot began, or moved on to `step`. */
export function recordBootStep(step: string): void {
  write({ phase: "starting", step, at: new Date().toISOString() });
}

/** Boot finished. */
export function recordBootCompleted(): void {
  write({ phase: "completed", step: null, at: new Date().toISOString() });
}

/** Boot failed at the step it was on. The error is logged by the caller, not kept here. */
export function recordBootFailed(): void {
  const current = read();
  write({
    phase: "failed",
    step: current.step ?? "unknown",
    at: new Date().toISOString(),
  });
}

export function getBootState(): BootState {
  return read();
}

/** Back to not started (tests only). */
export function resetBootState(): void {
  write(initial);
}
