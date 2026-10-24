/**
 * platform/observability/shutdown.ts — stopping an instance without losing work (ADR-055 D5)
 *
 * A container host stops an instance with SIGTERM, then SIGKILL after its grace period (Docker
 * 10 s by default — `docker stop -t` — ECS `stopTimeout` and Kubernetes
 * `terminationGracePeriodSeconds` 30 s). The Next.js standalone server exits at once on SIGTERM
 * unless NEXT_MANUAL_SIG_HANDLE=true — which the image sets — so this handler owns the stop, in
 * this order:
 *
 *   1. draining   readiness (/api/health/ready) answers 503 from now on, so the load balancer
 *                 stops sending traffic; liveness stays 200, so nothing restarts the instance.
 *                 The job runner stops claiming, and asks the attempt it is running to stop
 *                 (its AbortSignal): a cooperative handler ends at its next item and its job is
 *                 completed, continued or handed back unrun (platform/jobs/runner.ts).
 *   2. drain      wait SHUTDOWN_DRAIN_SECONDS (default 5) while the load balancer notices.
 *   3. in flight  wait until no request (and no job handler) is still running — every API route
 *                 is counted (./in-flight.ts) — up to the stop deadline: the bound less a
 *                 reserve for the steps below. The pools are never closed under a request that
 *                 finished in time.
 *   4. telemetry  flush buffered metrics (they are written through the database pools, so
 *                 before those close) and the error reporter.
 *   5. cache      close the selected cache.
 *   6. pools      close the database pools (platform/data).
 *   7. exit       0 when every step succeeded (nothing was still in flight), 1 when one failed.
 *
 * A step that fails is logged and the next one still runs. The whole stop is bounded by
 * SHUTDOWN_TIMEOUT_SECONDS (default 9, inside Docker's 10 s grace) from the first signal: past it
 * the process exits 1 whatever is still running. Keep the host's grace period longer than the
 * bound. The bound and the job tick agree: a tick in flight stops claiming at once and its
 * running attempt is told to stop, and the runner never waits for that attempt past the stop
 * deadline (stopDeadline()) — so a tick, whatever its 45-second budget, ends inside the bound. A
 * handler that ignores its signal is left to the process's exit: its lease lapses and the job runs
 * again (ADR-056 D2). A second signal (SIGTERM then SIGINT, or a host that repeats SIGTERM) joins
 * the stop already under way; it never starts another or skips the drain.
 *
 * Only installed where NEXT_MANUAL_SIG_HANDLE=true: otherwise Next.js's own handler exits first
 * and this one would be cut short. ADR-032: the draining flag and the installed flag are
 * globalThis singletons, so instrumentation and every route bundle read the same ones.
 *
 * @module platform/observability
 */

import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { inFlightCount, waitForIdle } from "./in-flight";
import {
  getShutdownSettings,
  type EnvSource,
  type ShutdownSettings,
} from "@/platform/providers/environment-contract";

export type { ShutdownSettings } from "@/platform/providers/environment-contract";

/** The signals a host stops an instance with. */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

interface ShutdownState {
  draining: boolean;
  installed: boolean;
  /** When the work in flight must be done by (epoch ms); null until a stop sets it. */
  deadline: number | null;
  readonly listeners: Set<() => void>;
}

const SHUTDOWN_KEY = "platform.observability.shutdown";

const fresh = (): ShutdownState => ({
  draining: false,
  installed: false,
  deadline: null,
  listeners: new Set(),
});

const state = (): ShutdownState => getSingleton<ShutdownState>(SHUTDOWN_KEY, fresh);

/** The most a stop keeps for its own steps (telemetry, cache, pools) after work in flight. */
export const STOP_RESERVE_MS = 2_000;

/** Whether this instance is stopping: readiness then answers not ready. */
export function isDraining(): boolean {
  return state().draining;
}

/**
 * Mark the instance as stopping, telling every listener (onDraining) once. `deadline` (epoch
 * ms): when work in flight must have ended (stopDeadline()).
 */
export function markDraining(deadline?: number): void {
  const s = state();
  if (deadline !== undefined && (s.deadline === null || deadline < s.deadline)) {
    s.deadline = deadline;
  }
  if (s.draining) return;
  s.draining = true;
  for (const listener of [...s.listeners]) {
    try {
      listener();
    } catch {
      // A listener's failure must not stop the stop.
    }
  }
}

/** When work in flight must be done by (epoch ms), once a stop has begun; else null. */
export function stopDeadline(): number | null {
  return state().deadline;
}

/** Call `listener` when the instance starts stopping (at once if it already has). Returns an unsubscribe. */
export function onDraining(listener: () => void): () => void {
  const s = state();
  if (s.draining) {
    listener();
    return () => undefined;
  }
  s.listeners.add(listener);
  return () => {
    s.listeners.delete(listener);
  };
}

/** Back to running, handlers not installed (tests only). */
export function resetShutdownState(): void {
  setSingleton<ShutdownState>(SHUTDOWN_KEY, fresh());
}

/** The work of a stop, in the order it runs after the drain. */
export interface ShutdownStep {
  readonly name: string;
  run(): Promise<void>;
}

export interface ShutdownDependencies {
  readonly settings: ShutdownSettings;
  /** Steps run in order after the drain; each failure is logged and the next one still runs. */
  readonly steps: readonly ShutdownStep[];
  /** Flips readiness and tells the job runner (default: markDraining), with the stop deadline. */
  readonly markDraining?: (deadline: number) => void;
  /** Work still in flight (default: ./in-flight.ts — every API route and stray job handler). */
  readonly inFlight?: {
    count(): number;
    /** True once idle, false if still busy after `timeoutMs`. */
    waitForIdle(timeoutMs: number): Promise<boolean>;
  };
  /** The clock (epoch ms). */
  readonly now?: () => number;
  readonly exit: (code: number) => void;
  readonly log?: (message: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/** One line per event; a stop is rare and must be visible at any LOG_LEVEL. */
const defaultLog = (message: string): void => {
  console.log(`[shutdown] ${message}`);
};

/**
 * A signal handler that stops the instance in the documented order. Calling it again while a
 * stop is under way returns the same promise: one stop per process.
 */
export function createShutdownHandler(
  deps: ShutdownDependencies
): (signal: string) => Promise<void> {
  const log = deps.log ?? defaultLog;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const flip = deps.markDraining ?? markDraining;
  const inFlight = deps.inFlight ?? { count: inFlightCount, waitForIdle };
  const now = deps.now ?? Date.now;
  let stopping: Promise<void> | null = null;
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  return (signal: string): Promise<void> => {
    if (stopping) {
      log(`${signal} received — already stopping`);
      return stopping;
    }
    const { drainMs, timeoutMs } = deps.settings;
    const startedAt = now();
    // Work in flight must end by here, leaving the steps below their reserve of the bound.
    const reserve = Math.min(STOP_RESERVE_MS, Math.max(0, (timeoutMs - drainMs) / 2));
    const deadline = startedAt + timeoutMs - reserve;
    flip(deadline);
    log(
      `${signal} received — not ready; draining for ${drainMs} ms (bound ${timeoutMs} ms)`
    );
    const hardStop = setTimer(() => {
      log(`did not finish within ${timeoutMs} ms — exiting 1`);
      exitOnce(1);
    }, timeoutMs);
    stopping = (async () => {
      await sleep(drainMs);
      let failed = false;
      const busy = inFlight.count();
      if (busy > 0) {
        log(`waiting for ${busy} request(s) or job(s) in flight`);
        const idle = await inFlight.waitForIdle(Math.max(0, deadline - now()));
        if (exited) return;
        if (idle) {
          log("in flight: done");
        } else {
          failed = true;
          log(
            `in flight: ${inFlight.count()} still running at the stop deadline — closing anyway`
          );
        }
      }
      for (const step of deps.steps) {
        if (exited) return;
        try {
          await step.run();
          log(`${step.name}: done`);
        } catch (err) {
          failed = true;
          log(`${step.name}: failed (${err instanceof Error ? err.name : "error"})`);
        }
      }
      clearTimer(hardStop);
      log(`stopped — exiting ${failed ? 1 : 0}`);
      exitOnce(failed ? 1 : 0);
    })();
    return stopping;
  };
}

/**
 * The platform's own stop steps: telemetry, then the cache, then the database pools. Loaded on
 * use, so importing this module does not pull in the database driver.
 */
export function platformShutdownSteps(): ShutdownStep[] {
  return [
    {
      name: "telemetry",
      run: async () => {
        const { tryGetObservability } = await import("./index");
        const observability = tryGetObservability();
        if (!observability) return;
        const sink = observability.metrics as { destroy?: () => void };
        sink.destroy?.();
        await observability.metrics.flush();
        await observability.errors.flush(2_000);
      },
    },
    {
      name: "cache",
      run: async () => {
        const { closeCache } = await import("@/platform/cache");
        await closeCache();
      },
    },
    {
      name: "database pools",
      run: async () => {
        const { closeDataPools } = await import("@/platform/data/pool");
        await closeDataPools();
      },
    },
  ];
}

/** The part of `process` the handler needs. */
export interface SignalTarget {
  on(signal: ShutdownSignal, listener: (signal: string) => void): unknown;
  exit(code: number): void;
}

/**
 * Whether this process owns its signals: Next.js leaves SIGTERM and SIGINT to the app only when
 * NEXT_MANUAL_SIG_HANDLE is set (the image sets "true").
 */
export function ownsSignals(env: EnvSource = process.env): boolean {
  return env.NEXT_MANUAL_SIG_HANDLE === "true";
}

/**
 * Install the handler on SIGTERM and SIGINT, once per process. Returns whether it is installed
 * (false where Next.js keeps the signals).
 */
export function installShutdownHandlers(
  target: SignalTarget = process,
  env: EnvSource = process.env
): boolean {
  if (!ownsSignals(env)) return false;
  const s = state();
  if (s.installed) return true;
  s.installed = true;
  const handler = createShutdownHandler({
    settings: getShutdownSettings(env),
    steps: platformShutdownSteps(),
    exit: (code) => target.exit(code),
  });
  for (const signal of SHUTDOWN_SIGNALS) {
    target.on(signal, (sig) => {
      void handler(typeof sig === "string" ? sig : signal);
    });
  }
  return true;
}
