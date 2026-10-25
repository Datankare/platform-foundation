/**
 * platform/cache/stamp-reader.ts — Reading a shared invalidation stamp, bounded (review 13 M2)
 *
 * The keys whose change must reach every instance at once (the agent registry, the capability map —
 * platform-config.ts; a user's permissions — permissions-cache.ts) are served from an instance's
 * cache only while their shared invalidation stamp is the one they were read under. So every read
 * of such a key reads its stamp from the shared cache first. Before review 13 that read had no
 * bound of its own: a shared cache that hung (a stalled TLS connection, a saturated server) held
 * every such read for as long as the client's own timeout — every permission check, every
 * capability decision — though the database could have answered at once.
 *
 * Now a stamp read is bounded and guarded:
 *
 *   - it waits at most STAMP_READ_TIMEOUT_MS (200 ms); past that the stamp is "unreadable";
 *   - after STAMP_BREAKER_FAILURES consecutive unreadable stamps the breaker OPENS: for
 *     STAMP_BREAKER_COOLDOWN_MS no stamp read is attempted at all (each is unreadable at once);
 *     then it is HALF-OPEN — one read is let through as a probe (the rest stay unreadable until it
 *     answers): a probe that answers closes the breaker, one that fails opens it again;
 *   - opening raises the alert `cache.stamp_breaker_open` (logged, counted as the metric
 *     `alert.cache.stamp_breaker_open`, reported); closing again is logged.
 *
 * Event-loop lag is not a cache failure (review 14 M-2). A stamp read's bound is measured on the
 * instance's own clock, and an instance whose event loop is stalled (CPU-saturated by other
 * requests) runs its timers before it reads its sockets: a cache that answered in a millisecond
 * would be "timed out", and five such requests opened the breaker on a healthy cache. So:
 *
 *   - when the bound expires the reader yields once (setImmediate: the poll phase runs, and an
 *     answer already in the socket is read) and takes a read that has settled by then;
 *   - a read still unsettled is unreadable (fail closed, as before) — but when the event loop was
 *     delayed by more than STAMP_LAG_BOUND_MS during it, it is counted as LAG, not as a cache
 *     failure: it neither opens the breaker nor fails a probe. It is counted as the metric
 *     `cache.stamp_read_lag` and alerted as `cache.stamp_read_lag` (the instance is overloaded —
 *     the cache may be fine);
 *   - the delay is measured for each read, over exactly its own time: a heartbeat timer that runs
 *     while the read is pending (every LAG_HEARTBEAT_MS; the largest gap by which it fired late)
 *     and how late the bound's own timer fired. The instance's event-loop delay is also measured
 *     continuously (perf_hooks monitorEventLoopDelay) and given with every lag event — p99 and max
 *     of the current minute — but it does not decide: one histogram serves every read, so it
 *     cannot be windowed to one read (a reset also drops the sample that spans a stall), and
 *     reading lag from before a read began would hide a real cache failure after a stall;
 *   - alerts are rate-limited per instance: at most one `cache.stamp_breaker_open` and one
 *     `cache.stamp_read_lag` per STAMP_ALERT_INTERVAL_MS (5 min), each carrying the count since
 *     the last one (a flapping cache raised one alert per opening before). The breaker-open text
 *     says it is the cache (the loop was responsive); the lag text says it is the instance.
 *
 * An unreadable stamp is never a reason to serve what is cached: every caller then reads the
 * database (and caches nothing under it). The breaker only spares the wait — correctness is the
 * caller's fail-closed reading of "unreadable", as before.
 *
 * The breaker's state is per instance, on globalThis (ADR-032).
 *
 * @module platform/cache
 */

import { monitorEventLoopDelay, type ELDHistogram } from "node:perf_hooks";
import { logger } from "@/lib/logger";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { raiseAlert } from "@/platform/observability/alert";
import { recordMetricEvent } from "@/platform/observability/metric-event";

/** How long one stamp read may wait on the shared cache. */
export const STAMP_READ_TIMEOUT_MS = 200;
/** Consecutive unreadable stamps that open the breaker. */
export const STAMP_BREAKER_FAILURES = 5;
/** How long an open breaker refuses stamp reads before it lets a probe through. */
export const STAMP_BREAKER_COOLDOWN_MS = 30_000;
/**
 * Event-loop delay during a read above which its timeout is lag, not a cache failure: half the
 * read's bound — the cache then had less than half of its time on a running loop.
 */
export const STAMP_LAG_BOUND_MS = STAMP_READ_TIMEOUT_MS / 2;
/** The least time between two alerts of one name from one instance. */
export const STAMP_ALERT_INTERVAL_MS = 5 * 60_000;

/** closed: reads go through. open: none do. half-open: one probe is in flight. */
export type StampBreakerState = "closed" | "open" | "half-open";

/** A rate-limited alert: when it was last raised, and how many were held back since. */
interface AlertGate {
  lastAt: number | null;
  held: number;
}

interface Breaker {
  failures: number;
  openedAt: number | null;
  probing: boolean;
  /** Timeouts counted as event-loop lag (never as failures), since this breaker was made. */
  lagged: number;
  openAlert: AlertGate;
  lagAlert: AlertGate;
}

const fresh = (): Breaker => ({
  failures: 0,
  openedAt: null,
  probing: false,
  lagged: 0,
  openAlert: { lastAt: null, held: 0 },
  lagAlert: { lastAt: null, held: 0 },
});

const STAMP_BREAKER_KEY = "platform.cache.stampBreaker";
const breaker = (): Breaker => getSingleton<Breaker>(STAMP_BREAKER_KEY, fresh);

/**
 * The instance's event-loop delay histogram (perf_hooks), enabled at the first stamp read and
 * reported with lag events. Kept apart from the breaker: a breaker reset (every test) must not
 * leave histograms enabled behind.
 */
interface LoopDelay {
  readonly histogram: ELDHistogram | null;
  /** When the histogram's current window began. */
  resetAt: number;
}
const LOOP_DELAY_KEY = "platform.cache.loopDelay";
/** How long one window of the instance's histogram runs. */
const LOOP_DELAY_WINDOW_MS = 60_000;
/** How often a pending read's heartbeat checks the loop. */
const LAG_HEARTBEAT_MS = 20;
const loopDelay = (): LoopDelay =>
  getSingleton<LoopDelay>(LOOP_DELAY_KEY, () => {
    let histogram: ELDHistogram | null = null;
    try {
      histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
    } catch {
      // A runtime without perf_hooks: the per-read measure still decides.
    }
    return { histogram, resetAt: Date.now() };
  });

/** The instance's event-loop delay in its current window (ms), for reports. */
export function instanceLoopDelay(now: number = Date.now()): {
  readonly p99Ms: number;
  readonly maxMs: number;
} {
  const d = loopDelay();
  const h = d.histogram;
  if (!h || h.count === 0) return { p99Ms: 0, maxMs: 0 };
  const out = {
    p99Ms: Math.round(h.percentile(99) / 1e6),
    maxMs: Math.round(h.max / 1e6),
  };
  if (now - d.resetAt >= LOOP_DELAY_WINDOW_MS) {
    h.reset();
    d.resetAt = now;
  }
  return out;
}

/** The breaker's state now (for health and tests). */
export function stampBreakerState(now: number = Date.now()): StampBreakerState {
  const b = breaker();
  if (b.openedAt === null) return "closed";
  if (b.probing || now - b.openedAt >= STAMP_BREAKER_COOLDOWN_MS) return "half-open";
  return "open";
}

/** Close the breaker and forget its failures (tests). */
export function resetStampBreaker(): void {
  setSingleton<Breaker>(STAMP_BREAKER_KEY, fresh());
}

/** Stamp-read timeouts counted as event-loop lag on this instance (health and tests). */
export function stampReadsLostToLag(): number {
  return breaker().lagged;
}

/** What a stamp read gave: the value, or that it could not be had (then nothing cached is trusted). */
export type StampRead<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

const UNREADABLE = { ok: false } as const;

/** Why a read did not answer in time. */
class StampReadTimeout extends Error {
  constructor(readonly lagMs: number) {
    super("stamp read timed out");
  }
}

/**
 * Run `read` (one or more shared-cache gets) bounded by STAMP_READ_TIMEOUT_MS, through the
 * breaker. Never throws. Waits at most the bound and one turn of the event loop.
 */
export async function readStamp<T>(read: () => Promise<T>): Promise<StampRead<T>> {
  const b = breaker();
  const now = Date.now();
  let probe = false;
  if (b.openedAt !== null) {
    if (b.probing || now - b.openedAt < STAMP_BREAKER_COOLDOWN_MS) return UNREADABLE;
    b.probing = true; // half-open: this read is the probe
    probe = true;
  }
  loopDelay(); // the instance's histogram runs from the first read on
  const startedAt = Date.now();
  // This read's own measure of the loop: the largest gap by which a heartbeat fired late.
  let worstGap = 0;
  let due = startedAt + LAG_HEARTBEAT_MS;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  const beat = () => {
    const at = Date.now();
    worstGap = Math.max(worstGap, at - due);
    due = at + LAG_HEARTBEAT_MS;
    heartbeat = setTimeout(beat, LAG_HEARTBEAT_MS);
    (heartbeat as { unref?: () => void }).unref?.();
  };
  heartbeat = setTimeout(beat, LAG_HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  let settled: { ok: true; value: T } | { ok: false; err: unknown } | undefined;
  // Started now, not in a later microtask: the request reaches the cache before any synchronous
  // work that follows the call (another request's) can stall the loop.
  const reading = new Promise<T>((resolve, reject) => {
    try {
      Promise.resolve(read()).then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  }).then(
    (value) => {
      settled = { ok: true, value };
      return value;
    },
    (err: unknown) => {
      settled = { ok: false, err };
      throw err;
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      reading,
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          // The bound has passed on this instance's clock — which a stalled loop runs before it
          // reads its sockets. One turn of the loop first (review 14 M-2): an answer already
          // received is then read, and taken.
          const firedAt = Date.now();
          setImmediate(() => {
            if (settled?.ok) return resolve(settled.value);
            if (settled) return reject(settled.err);
            const drift = firedAt - startedAt - STAMP_READ_TIMEOUT_MS;
            reject(new StampReadTimeout(Math.round(Math.max(drift, worstGap))));
          });
        }, STAMP_READ_TIMEOUT_MS);
        // Never keeps a process alive on its own.
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    succeeded(b, probe);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof StampReadTimeout && err.lagMs > STAMP_LAG_BOUND_MS) {
      lagged(b, probe, err.lagMs);
    } else {
      failed(b, probe, err);
    }
    return UNREADABLE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (heartbeat !== undefined) clearTimeout(heartbeat);
    // A read abandoned at the bound must not surface as an unhandled rejection later.
    reading.catch(() => {});
  }
}

function succeeded(b: Breaker, probe: boolean): void {
  if (probe || b.openedAt !== null) {
    logger.info("Shared-cache stamp reads recovered; the breaker is closed", {
      route: "platform/cache/stamp-reader",
    });
  }
  b.failures = 0;
  b.openedAt = null;
  b.probing = false;
}

/**
 * Whether an alert guarded by `gate` may be raised now (at most one per STAMP_ALERT_INTERVAL_MS);
 * returns how many it stands for (itself and those held back since the last), or 0 when held.
 */
function admit(gate: AlertGate, now: number): number {
  if (gate.lastAt !== null && now - gate.lastAt < STAMP_ALERT_INTERVAL_MS) {
    gate.held += 1;
    return 0;
  }
  const count = gate.held + 1;
  gate.lastAt = now;
  gate.held = 0;
  return count;
}

/** A timeout during event-loop lag: not the cache's failure (review 14 M-2). */
function lagged(b: Breaker, probe: boolean, lagMs: number): void {
  b.lagged += 1;
  // A probe lost to lag tells nothing about the cache: the next read probes again.
  if (probe) b.probing = false;
  const instance = instanceLoopDelay();
  recordMetricEvent(
    "cache.stamp_read_lag",
    { count: 1, lagMs, loopDelayP99Ms: instance.p99Ms, loopDelayMaxMs: instance.maxMs },
    { route: "platform/cache/stamp-reader" }
  );
  logger.warn(
    "A shared-cache stamp read timed out during event-loop lag (not counted as a cache failure)",
    {
      lagMs,
      route: "platform/cache/stamp-reader",
    }
  );
  const count = admit(b.lagAlert, Date.now());
  if (count === 0) return;
  raiseAlert({
    name: "cache.stamp_read_lag",
    message:
      `This instance's event loop was delayed by ${lagMs} ms (more than ${STAMP_LAG_BOUND_MS} ms; this minute p99 ${instance.p99Ms} ms, max ${instance.maxMs} ms) while it read invalidation stamps from the shared cache: ${count} stamp read(s) timed out because the INSTANCE was busy, not because the cache failed — they were read from the database instead and do not count towards the stamp breaker. Check this instance's CPU load and long synchronous work, not the cache.`.slice(
        0,
        500
      ),
    tags: {
      lagMs: String(lagMs),
      count: String(count),
      loopDelayMaxMs: String(instance.maxMs),
    },
    count,
  });
}

function failed(b: Breaker, probe: boolean, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  const lagMs = err instanceof StampReadTimeout ? err.lagMs : undefined;
  if (probe) {
    b.probing = false;
    b.openedAt = Date.now();
    logger.warn("Shared-cache stamp probe failed; the breaker stays open", {
      error: reason,
      route: "platform/cache/stamp-reader",
    });
    return;
  }
  b.failures += 1;
  if (b.openedAt === null && b.failures >= STAMP_BREAKER_FAILURES) {
    b.openedAt = Date.now();
    const count = admit(b.openAlert, b.openedAt);
    if (count === 0) {
      logger.warn("Shared-cache stamp breaker opened again (alert held: one per 5 min)", {
        failures: b.failures,
        route: "platform/cache/stamp-reader",
      });
      return;
    }
    const loop =
      lagMs !== undefined
        ? `the event loop was responsive (delay ${Math.max(0, lagMs)} ms ≤ ${STAMP_LAG_BOUND_MS} ms), so this is the cache, not instance lag`
        : "the cache refused the read, so this is the cache, not instance lag";
    raiseAlert({
      name: "cache.stamp_breaker_open",
      message:
        `The shared cache did not answer ${b.failures} invalidation-stamp reads in a row (last: ${reason}; ${loop}); for ${STAMP_BREAKER_COOLDOWN_MS / 1000} s stamped keys (permissions, the agent registry, the capability map) are read from the database without asking it. The breaker opened ${count} time(s) since the last alert. Check the cache (CACHE_PROVIDER).`.slice(
          0,
          500
        ),
      tags: { failures: String(b.failures), openings: String(count) },
      count,
    });
  }
}
