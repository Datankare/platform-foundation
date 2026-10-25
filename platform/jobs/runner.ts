/**
 * platform/jobs/runner.ts — run due work for a bounded time (ADR-056 D2)
 *
 * The host provides only a tick — Vercel Cron calling /api/internal/jobs/tick, or the CLI loop
 * (scripts/jobs-worker.mjs) on a container host — and each tick calls runDue({ budgetMs }):
 *
 *   1. Schedule. For each recurring kind whose governed setting says enabled, take its slot if
 *      due (store.takeScheduleSlot): its jobs — one platform job, or one per tenant it runs for —
 *      are enqueued in the same step, keyed by the slot, so two instances ticking at once
 *      enqueue them once.
 *   2. Claim a batch and run it, one job at a time, until nothing is due or the budget is spent.
 *      Only kinds whose attempt timeout fits in what is left are claimed, and only as many as fit
 *      end to end (at most CLAIM_BATCH); the claim takes tenants in turn (round-robin), so one
 *      tenant's backlog cannot starve the others. The batch's lease covers it plus a grace
 *      period, so a worker that dies leaves jobs another worker takes once the lease lapses. A
 *      claimed job that no longer fits when its turn comes is handed back unrun (release: its
 *      attempt not counted).
 *   3. Each job runs in its tenant's context (runWithTenant: every store and withTenantTx the
 *      handler reaches is scoped to that tenant, under its row-level security); a platform job
 *      from the platform's home tenant, holding the runner's JobAuthority. A handler that throws
 *      — anything, an Error or not — or runs past its timeout is retried after exponential
 *      backoff with jitter; after its last attempt it is dead-lettered, with the platform's own
 *      wording of the failure (./errors.ts). The full detail goes to the server log and the
 *      error reporter.
 *
 * A handler past its timeout is told to stop (its AbortSignal) and, briefly, waited for. One that
 * still runs is never settled while it runs — settling would queue a retry, and two copies of the
 * job would run at once. Instead its lease is extended while it runs (up to MAX_HUNG_MS), and it
 * is settled as timed out when it finally settles. Past MAX_HUNG_MS the lease is let go (and
 * reported): an attempt that hangs for that long is a defect, and only then can another worker
 * take the job.
 *
 * Stopping (SIGTERM on a container host, platform/observability/shutdown.ts): the runner claims
 * nothing more, hands back claimed jobs it has not started, and aborts the running attempt's
 * signal; it waits for that attempt no later than the stop deadline, so the tick ends inside the
 * shutdown bound. A handler that stops by throwing is handed back unrun; one that returns is
 * completed (with its continuation, if any).
 *
 * At least once: a job whose handler finished but whose settle was lost (a crash, a lapsed
 * lease) runs again, so every handler is idempotent.
 *
 * @module platform/jobs
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { logger } from "@/lib/logger";
import { getConfigBoolean, getConfigNumber } from "@/platform/auth/platform-config";
import { getSingleton } from "@/platform/kernel/singleton";
import { tryGetObservability } from "@/platform/observability";
import { beginInFlight } from "@/platform/observability/in-flight";
import { isDraining, onDraining, stopDeadline } from "@/platform/observability/shutdown";
import {
  DEFAULT_TENANT_ID,
  getTenancySettings,
} from "@/platform/providers/environment-contract";
import {
  runWithTenant,
  runWithoutTenant,
  type TenantContext,
} from "@/platform/tenancy/context";
import { claimRunnerAuthority } from "./authority";
import { retryDelayMs, uniformRandom } from "./backoff";
import { describeJobError, internalDetail, JobTimeoutError } from "./errors";
import { listJobDefinitions, listScheduledJobs, scheduleKeys } from "./registry";
import { getJobStore } from "./store";
import { SETTLE_MARGIN_MS } from "./tick";
import type {
  ClaimedJob,
  JobContext,
  JobResult,
  JobStore,
  ResolvedJobDefinition,
  ScheduleOutcome,
} from "./types";

export { SETTLE_MARGIN_MS } from "./tick";

/** The runner's authority, held by this module alone and given to platform jobs' handlers. */
const RUNNER_AUTHORITY = claimRunnerAuthority();

/** Added to a kind's timeout for its lease: time to settle after the attempt ends. */
export const LEASE_GRACE_MS = 30_000;
/** Below this much budget, a tick does not start scheduling. */
const SCHEDULE_MIN_MS = 3_000;
/** The longest budget one call may have (a tick is a request; the CLI loop calls repeatedly). */
export const MAX_BUDGET_MS = 14 * 60_000;
/** The most jobs one claim takes (each must still fit, end to end, in the budget). */
export const CLAIM_BATCH = 10;
/** How long past its timeout the runner waits, in the tick, for a handler to settle. */
export const HUNG_WAIT_MS = 5_000;
/** How long a handler still running past its time keeps its job's lease (extended). */
export const MAX_HUNG_MS = 15 * 60_000;
/** How often a running-past-its-time handler's lease is extended (to LEASE_GRACE_MS from then). */
const HEARTBEAT_MS = 10_000;

export interface RunDueOptions {
  /** How long this call may take, in ms (1 s – 14 min). */
  readonly budgetMs: number;
  /** Only these kinds (an operator's "run now"); default every registered kind. */
  readonly kinds?: readonly string[];
  /** Take due schedule slots first (default true). */
  readonly schedule?: boolean;
  readonly workerId?: string;
  readonly store?: JobStore;
  /** The clock (epoch ms) and the jitter source — injectable for tests. */
  readonly now?: () => number;
  readonly random?: () => number;
  /** How long past a timeout to wait for the handler in the tick (default HUNG_WAIT_MS). */
  readonly hungWaitMs?: number;
}

export interface RunDueReport {
  readonly workerId: string;
  readonly scheduled: readonly { readonly kind: string; readonly enqueued: number }[];
  readonly scheduleErrors: number;
  /** Jobs whose attempt started. */
  readonly claimed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly dead: number;
  /** Turned off for their tenant (a tenant opt-out). */
  readonly skipped: number;
  /** Settles refused because the lease had lapsed and the job was taken again. */
  readonly lostLease: number;
  /** Next parts enqueued by handlers whose batch was full. */
  readonly continued: number;
  /** Claimed but handed back unrun (no time left in the budget, or the instance is stopping). */
  readonly released: number;
  /**
   * Handlers still running past their time when the tick moved on: their leases are extended
   * while they run, and they are settled when they settle.
   */
  readonly hung: number;
  readonly stoppedBy: "idle" | "budget" | "draining";
  readonly durationMs: number;
}

/** A worker's id: host, process and a random suffix (shown on a running job's lease). */
export function newWorkerId(): string {
  const host =
    hostname()
      .replace(/[^\w.-]/g, "")
      .slice(0, 60) || "host";
  return `${host}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * The tenant a platform job runs from: the single tenant of a dedicated deployment, else the
 * default tenant — the one operators act from (docs/TENANCY_OPERATIONS.md), so the job's audit
 * records sit with theirs.
 */
export function platformHomeTenant(): TenantContext {
  const t = getTenancySettings();
  return t.mode === "single"
    ? { tenantId: t.tenantId, mode: "single" }
    : { tenantId: DEFAULT_TENANT_ID, mode: "shared" };
}

function jobTenant(job: ClaimedJob): TenantContext {
  if (job.tenantId === null) return platformHomeTenant();
  return { tenantId: job.tenantId, mode: getTenancySettings().mode };
}

/** A recurring kind's governed interval, clamped to its bounds; its default when unreadable. */
export async function scheduleInterval(
  def: ResolvedJobDefinition & {
    schedule: NonNullable<ResolvedJobDefinition["schedule"]>;
  }
): Promise<number> {
  const s = def.schedule;
  let minutes = s.defaultIntervalMinutes;
  try {
    const v = await getConfigNumber(
      scheduleKeys(def.kind).interval,
      s.defaultIntervalMinutes
    );
    if (Number.isFinite(v)) minutes = Math.floor(v);
  } catch {
    // unreadable: the default
  }
  return Math.min(s.maxIntervalMinutes, Math.max(s.minIntervalMinutes, minutes));
}

/** Whether a recurring kind is on. Unreadable: on — a safety duty never stops on a read error. */
export async function scheduleEnabled(kind: string): Promise<boolean> {
  try {
    return await getConfigBoolean(scheduleKeys(kind).enabled, true);
  } catch {
    return true;
  }
}

async function takeDueSlots(
  store: JobStore,
  kinds: ReadonlySet<string> | null,
  report: { scheduled: { kind: string; enqueued: number }[]; scheduleErrors: number },
  now: () => number
): Promise<void> {
  const tenancy = getTenancySettings();
  // Read outside any tenant: the platform's defaults govern schedules.
  await runWithoutTenant(async () => {
    for (const def of listScheduledJobs()) {
      if (kinds && !kinds.has(def.kind)) continue;
      if (isDraining()) return;
      try {
        if (!(await scheduleEnabled(def.kind))) continue;
        const minutes = await scheduleInterval(def);
        const slot = await store.takeScheduleSlot({
          kind: def.kind,
          scope: def.schedule.scope,
          intervalMs: minutes * 60_000,
          maxAttempts: def.maxAttempts,
          now: new Date(now()),
          runsForSuspended: def.runsForSuspended,
          ...(def.schedule.scope === "each-tenant" && tenancy.mode === "single"
            ? { tenantIds: [tenancy.tenantId] }
            : {}),
        });
        if (slot) report.scheduled.push({ kind: def.kind, enqueued: slot.enqueued });
      } catch (err) {
        report.scheduleErrors++;
        logger.error("Jobs: could not take a schedule slot", {
          kind: def.kind,
          error: internalDetail(err),
          route: "platform/jobs/runner",
        });
      }
    }
  });
}

/** How an attempt ended. */
type Settled =
  | { readonly ok: true; readonly result: JobResult; readonly skipped: boolean }
  | { readonly ok: false; readonly error: unknown }
  /** Stopped by the instance stopping (its signal), by throwing: handed back unrun. */
  | { readonly ok: "released" };

type Attempt =
  | Settled
  /** Still running past its time: `settled` resolves with its outcome when it does. */
  | { readonly ok: "hung"; readonly settled: Promise<Settled> };

/** Why an attempt's signal was aborted. */
const DRAINING = Symbol("draining");

/** A promise resolving once the stop deadline passes (never, while no stop has begun). */
function stopCutoff(): { readonly promise: Promise<"cut">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveCut: (v: "cut") => void = () => undefined;
  const promise = new Promise<"cut">((r) => (resolveCut = r));
  const arm = () => {
    const deadline = stopDeadline();
    if (deadline === null) return;
    timer = setTimeout(() => resolveCut("cut"), Math.max(0, deadline - Date.now()));
  };
  const unsubscribe = onDraining(arm);
  return {
    promise,
    cancel: () => {
      unsubscribe();
      clearTimeout(timer);
    },
  };
}

const delay = <T>(ms: number, value: T): { promise: Promise<T>; cancel(): void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((r) => {
    timer = setTimeout(() => r(value), Math.max(0, ms));
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

/** Run one attempt in the job's tenant, bounded by `deadline`. Never throws. */
async function attempt(
  def: ResolvedJobDefinition,
  job: ClaimedJob,
  deadline: number,
  now: () => number,
  waitPastTimeoutMs: number
): Promise<Attempt> {
  const controller = new AbortController();
  const ctx: JobContext = Object.freeze({
    jobId: job.id,
    kind: job.kind,
    tenantId: job.tenantId,
    payload: job.payload,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    source: job.source,
    signal: controller.signal,
    deadline,
    agent: `job:${job.kind}`,
    authority: job.tenantId === null ? RUNNER_AUTHORITY : null,
  });
  const optOut = def.schedule?.tenantOptOutKey;
  const stopWatch = onDraining(() => controller.abort(DRAINING));
  const cutoff = stopCutoff();
  const run = new Promise<Settled>((resolve) => {
    try {
      const pending = runWithTenant(jobTenant(job), async (): Promise<Settled> => {
        if (optOut && job.tenantId !== null && !(await getConfigBoolean(optOut, true))) {
          return { ok: true, result: {}, skipped: true };
        }
        const result = await def.handler(ctx);
        return { ok: true, result: result ?? {}, skipped: false };
      });
      pending.then(resolve, (error: unknown) => resolve({ ok: false, error }));
    } catch (error) {
      resolve({ ok: false, error });
    }
  });
  // A handler that stopped because the instance is stopping, by throwing: unrun, not failed.
  const outcome = (a: Settled): Settled =>
    a.ok === false && controller.signal.reason === DRAINING ? { ok: "released" } : a;
  const timeout = delay(deadline - now(), "timeout" as const);
  let wait: { cancel(): void } | undefined;
  try {
    const first = await Promise.race([run, timeout.promise, cutoff.promise]);
    if (first === "cut") return { ok: "hung", settled: run.then(outcome) };
    if (first !== "timeout") return outcome(first);
    // Past its time: told to stop, and waited for briefly — never past the stop deadline.
    controller.abort(new JobTimeoutError(def.timeoutMs));
    const timedOut: Settled = { ok: false, error: new JobTimeoutError(def.timeoutMs) };
    const late = delay(waitPastTimeoutMs, "late" as const);
    wait = late;
    const second = await Promise.race([run, late.promise, cutoff.promise]);
    if (second === "late" || second === "cut") {
      return { ok: "hung", settled: run.then(() => timedOut) };
    }
    return timedOut;
  } finally {
    timeout.cancel();
    wait?.cancel();
    cutoff.cancel();
    stopWatch();
  }
}

interface HungJobs {
  readonly settling: Set<Promise<void>>;
}
const hungJobs = (): HungJobs =>
  getSingleton<HungJobs>("platform.jobs.hung", () => ({ settling: new Set() }));

/** Handlers left running past their time, not yet settled. */
export function hungJobCount(): number {
  return hungJobs().settling.size;
}

/** Wait until every handler left running has settled and its job is settled (tests, shutdown). */
export async function settleHungJobs(): Promise<void> {
  while (hungJobs().settling.size > 0) {
    await Promise.all([...hungJobs().settling]);
  }
}

/**
 * Keep a still-running handler's job leased until it settles (at most MAX_HUNG_MS), then settle
 * it — so no other worker runs the job meanwhile. Counted as in flight, so a stopping instance
 * waits for it (up to its bound).
 */
function adoptHung(
  store: JobStore,
  def: ResolvedJobDefinition,
  job: ClaimedJob,
  settled: Promise<Settled>,
  now: () => number,
  random: () => number
): void {
  const endInFlight = beginInFlight();
  const where = { jobId: job.id, kind: job.kind, tenantId: job.tenantId ?? "platform" };
  const since = Date.now();
  let letGo = false;
  const extend = () =>
    store.extendLease(job, LEASE_GRACE_MS).then(
      (held) => {
        if (!held) logger.warn("Jobs: lost the lease of a handler still running", where);
      },
      (err: unknown) =>
        logger.error("Jobs: could not extend a running handler's lease", {
          ...where,
          error: internalDetail(err),
        })
    );
  void extend();
  const beat = setInterval(() => {
    if (Date.now() - since >= MAX_HUNG_MS) {
      letGo = true;
      clearInterval(beat);
      logger.error("Jobs: a handler has run far past its time; its lease is let go", {
        ...where,
        runningMs: Date.now() - since,
      });
      tryGetObservability()?.errors.captureError(
        new Error(
          `Job ${job.kind} handler still running ${MAX_HUNG_MS} ms past its time`
        ),
        { tags: { kind: job.kind, route: "platform/jobs" }, extra: { jobId: job.id } }
      );
      endInFlight();
      return;
    }
    void extend();
  }, HEARTBEAT_MS);
  (beat as { unref?: () => void }).unref?.();
  logger.warn("Jobs: a handler is still running past its time; its lease is kept", where);
  const done: Promise<void> = settled
    .then(async (outcome) => {
      clearInterval(beat);
      if (letGo) return;
      const report = {
        succeeded: 0,
        retried: 0,
        dead: 0,
        skipped: 0,
        lostLease: 0,
        continued: 0,
        released: 0,
      };
      await settle(store, def, job, outcome, report, now, random);
    })
    .catch((err: unknown) => {
      logger.error("Jobs: could not settle a job after its handler stopped", {
        ...where,
        error: internalDetail(err),
      });
    })
    .finally(() => {
      endInFlight();
      hungJobs().settling.delete(done);
    });
  hungJobs().settling.add(done);
}

/** Hand back claimed jobs not started; best effort (an unreleased one's lease lapses). */
async function releaseAll(
  store: JobStore,
  jobs: readonly ClaimedJob[],
  report: { released: number }
): Promise<void> {
  for (const job of jobs) {
    try {
      if (await store.release(job)) report.released++;
    } catch (err) {
      logger.error("Jobs: could not hand back a claimed job; its lease will lapse", {
        jobId: job.id,
        kind: job.kind,
        error: internalDetail(err),
        route: "platform/jobs/runner",
      });
    }
  }
}

/**
 * Run due work for at most `budgetMs`. Returns what was done; throws only for an invalid budget
 * (a store failure while claiming ends the call and is logged).
 *
 * @external It runs registered job handlers, which may reach outside the database: an audited act
 * that calls it passes `{ external: true }` (review 14 L-6; __tests__/audited-external-guard.test.ts
 * reads this tag).
 */
export async function runDue(options: RunDueOptions): Promise<RunDueReport> {
  const budget = options.budgetMs;
  if (!Number.isInteger(budget) || budget < 1_000 || budget > MAX_BUDGET_MS) {
    throw new RangeError(`budgetMs must be 1 s – ${MAX_BUDGET_MS / 60_000} min`);
  }
  const now = options.now ?? Date.now;
  const random = options.random ?? uniformRandom;
  const store = options.store ?? getJobStore();
  const workerId = options.workerId ?? newWorkerId();
  const hungWait = options.hungWaitMs ?? HUNG_WAIT_MS;
  const started = now();
  const end = started + budget;
  const only = options.kinds ? new Set(options.kinds) : null;
  const defs = new Map(
    listJobDefinitions()
      .filter((d) => !only || only.has(d.kind))
      .map((d) => [d.kind, d])
  );

  const report = {
    scheduled: [] as { kind: string; enqueued: number }[],
    scheduleErrors: 0,
    claimed: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
    skipped: 0,
    lostLease: 0,
    continued: 0,
    released: 0,
    hung: 0,
  };

  if (options.schedule !== false && !isDraining() && end - now() >= SCHEDULE_MIN_MS) {
    await takeDueSlots(store, only, report, now);
  }

  let stoppedBy: RunDueReport["stoppedBy"] = "idle";
  claiming: for (;;) {
    if (isDraining()) {
      stoppedBy = "draining";
      break;
    }
    const left = end - now() - SETTLE_MARGIN_MS;
    const fits = [...defs.values()].filter((d) => d.timeoutMs <= left);
    if (fits.length === 0) {
      stoppedBy = "budget";
      break;
    }
    const longest = Math.max(...fits.map((d) => d.timeoutMs));
    // As many as can run end to end in what is left, each at its longest.
    const limit = Math.max(1, Math.min(CLAIM_BATCH, Math.floor(left / longest)));
    const leaseMs = limit * longest + LEASE_GRACE_MS;
    let claimed: ClaimedJob[];
    try {
      claimed = await store.claim({
        workerId,
        kinds: fits.map((d) => d.kind),
        limit,
        leaseMs,
      });
    } catch (err) {
      logger.error("Jobs: claim failed", {
        error: internalDetail(err),
        workerId,
        route: "platform/jobs/runner",
      });
      break;
    }
    if (claimed.length === 0) break;
    for (let i = 0; i < claimed.length; i++) {
      const job = claimed[i];
      const def = defs.get(job.kind)!;
      const draining = isDraining();
      if (draining || def.timeoutMs > end - now() - SETTLE_MARGIN_MS) {
        await releaseAll(store, claimed.slice(i), report);
        stoppedBy = draining ? "draining" : "budget";
        break claiming;
      }
      report.claimed++;
      const deadline = now() + def.timeoutMs;
      // Past its time, wait in the tick no longer than the budget allows.
      const waitPast = Math.max(0, Math.min(hungWait, end - SETTLE_MARGIN_MS - deadline));
      const outcome = await attempt(def, job, deadline, now, waitPast);
      if (outcome.ok === "hung") {
        report.hung++;
        adoptHung(store, def, job, outcome.settled, now, random);
        continue;
      }
      try {
        await settle(store, def, job, outcome, report, now, random);
      } catch (err) {
        // The settle could not be written: the lease lapses and the job runs again (at least once).
        logger.error("Jobs: could not settle a job", {
          jobId: job.id,
          kind: job.kind,
          error: internalDetail(err),
          route: "platform/jobs/runner",
        });
        await releaseAll(store, claimed.slice(i + 1), report);
        break claiming;
      }
    }
  }

  const done: RunDueReport = {
    workerId,
    ...report,
    stoppedBy,
    durationMs: now() - started,
  };
  logger.info("Jobs: tick", { ...done, scheduled: done.scheduled.length });
  return done;
}

async function recordOutcome(
  store: JobStore,
  def: ResolvedJobDefinition,
  job: ClaimedJob,
  status: ScheduleOutcome,
  error: string | null
): Promise<void> {
  if (!def.schedule) return;
  try {
    await store.recordScheduleOutcome(job.kind, job.tenantId, status, error);
  } catch (err) {
    // The job itself is settled; only the console's summary is behind.
    logger.error("Jobs: could not record a schedule outcome", {
      jobId: job.id,
      kind: job.kind,
      error: internalDetail(err),
      route: "platform/jobs/runner",
    });
  }
}

async function settle(
  store: JobStore,
  def: ResolvedJobDefinition,
  job: ClaimedJob,
  outcome: Settled,
  report: {
    succeeded: number;
    retried: number;
    dead: number;
    skipped: number;
    lostLease: number;
    continued: number;
    released: number;
  },
  now: () => number,
  random: () => number
): Promise<void> {
  const where = { jobId: job.id, kind: job.kind, tenantId: job.tenantId ?? "platform" };
  if (outcome.ok === "released") {
    if (await store.release(job)) report.released++;
    else report.lostLease++;
    logger.info("Jobs: stopped for the instance's shutdown; handed back unrun", where);
    return;
  }
  if (outcome.ok) {
    if (!(await store.complete(job))) {
      report.lostLease++;
      logger.warn("Jobs: finished after its lease was lost; it may run again", where);
      return;
    }
    if (outcome.skipped) report.skipped++;
    else report.succeeded++;
    logger.info("Jobs: succeeded", {
      ...where,
      attempt: job.attempts,
      ...(outcome.result.summary ?? {}),
      ...(outcome.skipped ? { skipped: "tenant opt-out" } : {}),
    });
    await recordOutcome(store, def, job, "succeeded", null);
    if (outcome.result.continueWith && !outcome.skipped) {
      const next = await store.enqueue({
        tenantId: job.tenantId,
        kind: job.kind,
        payload: outcome.result.continueWith,
        idempotencyKey: `continue:${job.id}`,
        maxAttempts: def.maxAttempts,
        source: job.source,
        runsForSuspended: def.runsForSuspended,
      });
      if (next.created) report.continued++;
    }
    return;
  }

  const wording = describeJobError(outcome.error);
  const detail = internalDetail(outcome.error);
  if (job.attempts >= job.maxAttempts) {
    if (!(await store.bury(job, wording))) {
      report.lostLease++;
      return;
    }
    report.dead++;
    logger.error("Jobs: dead-lettered after its last attempt", {
      ...where,
      attempt: job.attempts,
      error: detail,
    });
    tryGetObservability()?.errors.captureError(
      new Error(`Job ${job.kind} dead-lettered: ${wording}`),
      { tags: { kind: job.kind, route: "platform/jobs" }, extra: { jobId: job.id } }
    );
    await recordOutcome(store, def, job, "dead", wording);
    return;
  }
  const delayMs = retryDelayMs(job.attempts, def.backoff, random);
  if (!(await store.retry(job, wording, new Date(now() + delayMs)))) {
    report.lostLease++;
    return;
  }
  report.retried++;
  logger.warn("Jobs: attempt failed; will retry", {
    ...where,
    attempt: job.attempts,
    retryInMs: delayMs,
    error: detail,
  });
  await recordOutcome(store, def, job, "retrying", wording);
}
