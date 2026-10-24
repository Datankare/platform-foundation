/**
 * @jest-environment node
 */
/**
 * Graceful shutdown (ADR-055 D5): on SIGTERM or SIGINT the instance answers not ready first, drains,
 * flushes telemetry (written through the database pools, so before they close), closes the cache,
 * closes the pools, then exits — 0 when every step succeeded. A second signal joins the stop under
 * way; a step that fails does not stop the others; a stop that overruns its bound exits 1.
 *
 * Hostile cases: SIGTERM twice and SIGINT on top, a step that throws, a step that never finishes,
 * a stop that begins while readiness probes are running, installing twice, Next.js keeping the
 * signals (NEXT_MANUAL_SIG_HANDLE unset), a request still running when the drain ends, one that
 * outlives the stop deadline, and a job tick in flight (review finding 1: the pools were closed
 * under requests in flight, and the runner kept claiming while draining).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "shutdown-req-id",
}));

import type { Pool } from "pg";
import { GET as live } from "@/app/api/health/live/route";
import { GET as ready } from "@/app/api/health/ready/route";
import { GET as health } from "@/app/api/health/route";
import { getCache, closeCache, InMemoryCacheProvider } from "@/platform/cache";
import { closeDataPools, getPool, setDataPoolFactory } from "@/platform/data/pool";
import {
  initObservability,
  resetObservability,
  type HealthProbe,
  type MetricsSink,
} from "@/platform/observability";
import { recordBootCompleted, resetBootState } from "@/platform/observability/boot";
import { checkReadiness } from "@/platform/observability/readiness";
import {
  createShutdownHandler,
  installShutdownHandlers,
  isDraining,
  markDraining,
  ownsSignals,
  platformShutdownSteps,
  resetShutdownState,
  type ShutdownStep,
  type SignalTarget,
} from "@/platform/observability/shutdown";
import { PLATFORM_VERSION } from "@/platform/version";
import { inFlightCount, resetInFlight } from "@/platform/observability/in-flight";
import { stopDeadline, STOP_RESERVE_MS } from "@/platform/observability/shutdown";
import { tenantRoute } from "@/platform/tenancy/route";
import {
  InMemoryJobStore,
  registerJob,
  resetJobRegistry,
  resetJobStore,
  runDue,
  setJobStore,
  type JobContext,
} from "@/platform/jobs";

const healthyProbe = (name: string): HealthProbe => ({
  name,
  check: async () => ({ name, status: "healthy", checkedAt: new Date().toISOString() }),
});

function bootHealthy(extra: { metricsSink?: MetricsSink } = {}) {
  initObservability({
    environment: "test",
    version: PLATFORM_VERSION,
    healthProbes: [healthyProbe("database"), healthyProbe("cache")],
    ...extra,
  });
  recordBootCompleted();
}

/** A handler whose every effect is recorded in order, with the drain resolved by the test. */
function harness(
  options: {
    steps?: ShutdownStep[];
    drainMs?: number;
    timeoutMs?: number;
    inFlight?: { count(): number; waitForIdle(ms: number): Promise<boolean> };
  } = {}
) {
  const events: string[] = [];
  let releaseDrain: () => void = () => undefined;
  let fireTimeout: () => void = () => undefined;
  const step = (name: string): ShutdownStep => ({
    name,
    run: async () => {
      events.push(name);
    },
  });
  const handler = createShutdownHandler({
    settings: {
      drainMs: options.drainMs ?? 5_000,
      timeoutMs: options.timeoutMs ?? 9_000,
    },
    steps: options.steps ?? [step("telemetry"), step("cache"), step("database pools")],
    markDraining: (deadline) => {
      events.push("not ready");
      markDraining(deadline);
    },
    ...(options.inFlight ? { inFlight: options.inFlight } : {}),
    exit: (code) => events.push(`exit ${code}`),
    log: (m) => events.push(`log: ${m}`),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        events.push(`drain ${ms}`);
        releaseDrain = resolve;
      }),
    setTimer: (fn, ms) => {
      events.push(`bound ${ms}`);
      fireTimeout = fn;
      return "timer";
    },
    clearTimer: (t) => events.push(`clear ${String(t)}`),
  });
  return {
    events,
    handler,
    releaseDrain: () => releaseDrain(),
    fireTimeout: () => fireTimeout(),
    effects: () => events.filter((e) => !e.startsWith("log: ")),
  };
}

beforeEach(() => {
  resetShutdownState();
  resetObservability();
  resetBootState();
  resetInFlight();
});
afterAll(async () => {
  resetShutdownState();
  resetObservability();
  resetBootState();
  await closeDataPools();
});

describe("the stop, in order", () => {
  it("not ready first, then the drain, then telemetry, cache, pools — and exit 0", async () => {
    const h = harness();
    const done = h.handler("SIGTERM");
    // Readiness flips before anything waits.
    expect(isDraining()).toBe(true);
    expect(h.effects()).toEqual(["not ready", "bound 9000", "drain 5000"]);
    h.releaseDrain();
    await done;
    expect(h.effects()).toEqual([
      "not ready",
      "bound 9000",
      "drain 5000",
      "telemetry",
      "cache",
      "database pools",
      "clear timer",
      "exit 0",
    ]);
    expect(h.events).toContain(
      "log: SIGTERM received — not ready; draining for 5000 ms (bound 9000 ms)"
    );
  });

  it("a second signal joins the stop under way: one drain, each step once, one exit", async () => {
    const h = harness();
    const first = h.handler("SIGTERM");
    const second = h.handler("SIGTERM");
    const third = h.handler("SIGINT");
    expect(second).toBe(first);
    expect(third).toBe(first);
    h.releaseDrain();
    await Promise.all([first, second, third]);
    // Signals after the stop finished change nothing either.
    await h.handler("SIGTERM");
    const effects = h.effects();
    expect(effects.filter((e) => e === "not ready")).toHaveLength(1);
    expect(effects.filter((e) => e.startsWith("drain"))).toHaveLength(1);
    expect(effects.filter((e) => e === "database pools")).toHaveLength(1);
    expect(effects.filter((e) => e.startsWith("exit"))).toEqual(["exit 0"]);
    expect(h.events).toContain("log: SIGTERM received — already stopping");
    expect(h.events).toContain("log: SIGINT received — already stopping");
  });

  it("a step that fails is logged, the next ones still run, and the exit is 1", async () => {
    const order: string[] = [];
    const h = harness({
      steps: [
        {
          name: "telemetry",
          run: async () => {
            order.push("telemetry");
            throw new Error("metrics database said no: password=hunter2");
          },
        },
        { name: "cache", run: async () => void order.push("cache") },
        { name: "database pools", run: async () => void order.push("pools") },
      ],
    });
    const done = h.handler("SIGTERM");
    h.releaseDrain();
    await done;
    expect(order).toEqual(["telemetry", "cache", "pools"]);
    expect(h.effects().at(-1)).toBe("exit 1");
    expect(h.events).toContain("log: telemetry: failed (Error)");
    // The failure's message (which may carry a credential) is never logged.
    expect(h.events.join("\n")).not.toMatch(/hunter2/);
  });

  it("past its bound the stop exits 1, once, and runs no further step", async () => {
    let finishCache: () => void = () => undefined;
    const ran: string[] = [];
    const h = harness({
      steps: [
        { name: "telemetry", run: async () => void ran.push("telemetry") },
        {
          name: "cache",
          run: () =>
            new Promise<void>((resolve) => {
              ran.push("cache");
              finishCache = resolve;
            }),
        },
        { name: "database pools", run: async () => void ran.push("pools") },
      ],
    });
    const done = h.handler("SIGTERM");
    h.releaseDrain();
    await new Promise((r) => setImmediate(r));
    expect(ran).toEqual(["telemetry", "cache"]);
    h.fireTimeout();
    expect(h.effects().filter((e) => e.startsWith("exit"))).toEqual(["exit 1"]);
    expect(h.events).toContain("log: did not finish within 9000 ms — exiting 1");
    finishCache();
    await done;
    expect(ran).toEqual(["telemetry", "cache"]);
    expect(h.effects().filter((e) => e.startsWith("exit"))).toEqual(["exit 1"]);
  });

  it("defaults to real timers: a zero drain stops at once", async () => {
    const exits: number[] = [];
    const steps: string[] = [];
    const handler = createShutdownHandler({
      settings: { drainMs: 0, timeoutMs: 1_000 },
      steps: [{ name: "only", run: async () => void steps.push("only") }],
      exit: (c) => exits.push(c),
      log: () => undefined,
    });
    await handler("SIGINT");
    expect(steps).toEqual(["only"]);
    expect(exits).toEqual([0]);
    expect(isDraining()).toBe(true);
  });
});

describe("work in flight when the drain ends (review finding 1)", () => {
  it("waits for a request still running before closing anything, then exits 0", async () => {
    let finish: () => void = () => undefined;
    const slow = tenantRoute(
      async () =>
        new Promise<string>((r) => {
          finish = () => r("200 from the slow request");
        })
    );
    const response = slow();
    expect(inFlightCount()).toBe(1);
    const h = harness();
    const done = h.handler("SIGTERM");
    h.releaseDrain();
    await new Promise((r) => setTimeout(r, 20));
    // Drained, but the request still runs: nothing is closed yet.
    expect(h.effects()).toEqual(["not ready", "bound 9000", "drain 5000"]);
    expect(h.events).toContain("log: waiting for 1 request(s) or job(s) in flight");
    finish();
    expect(await response).toBe("200 from the slow request");
    await done;
    expect(h.effects()).toEqual([
      "not ready",
      "bound 9000",
      "drain 5000",
      "telemetry",
      "cache",
      "database pools",
      "clear timer",
      "exit 0",
    ]);
  });

  it("gives the steps their reserve: past the stop deadline it closes anyway, and exits 1", async () => {
    let waited = -1;
    const h = harness({
      inFlight: {
        count: () => 1,
        waitForIdle: async (ms) => {
          waited = ms;
          return false;
        },
      },
    });
    const done = h.handler("SIGTERM");
    h.releaseDrain();
    await done;
    // The wait ends STOP_RESERVE_MS before the bound (the drain was instant in this harness).
    expect(waited).toBeGreaterThan(9_000 - STOP_RESERVE_MS - 100);
    expect(waited).toBeLessThanOrEqual(9_000 - STOP_RESERVE_MS);
    expect(h.effects().slice(-2)).toEqual(["clear timer", "exit 1"]);
    expect(h.effects()).toContain("database pools");
    expect(
      h.events.some((e) =>
        e.includes("still running at the stop deadline — closing anyway")
      )
    ).toBe(true);
  });

  it("tells the job runner the stop deadline as it flips readiness", async () => {
    const before = Date.now();
    const h = harness({ drainMs: 5_000, timeoutMs: 20_000 });
    const done = h.handler("SIGTERM");
    const deadline = stopDeadline()!;
    expect(deadline).toBeGreaterThanOrEqual(before + 20_000 - STOP_RESERVE_MS);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 20_000 - STOP_RESERVE_MS);
    h.releaseDrain();
    await done;
  });

  it("a tick in flight stops claiming, stops its attempt, and ends before the pools close", async () => {
    const store = new InMemoryJobStore({
      activeTenants: async () => ["00000000-0000-4000-8000-000000000001"],
    });
    setJobStore(store);
    const kind = "test.shutdown-tick";
    let attempts = 0;
    registerJob(
      kind,
      async (ctx: JobContext) => {
        attempts++;
        // A cooperative duty: works item by item until told to stop.
        while (!ctx.signal.aborted) await new Promise((r) => setTimeout(r, 10));
        return { continueWith: { part: "next" } };
      },
      { description: "Works until told to stop.", timeoutMs: 20_000 }
    );
    try {
      for (let i = 0; i < 3; i++) {
        await store.enqueue({
          tenantId: "00000000-0000-4000-8000-000000000001",
          kind,
          idempotencyKey: `t${i}`,
          maxAttempts: 3,
          source: "schedule",
        });
      }
      const tick = tenantRoute(() =>
        runDue({ budgetMs: 45_000, kinds: [kind], schedule: false })
      );
      const report = tick();
      await new Promise((r) => setTimeout(r, 30));
      expect(attempts).toBe(1);
      const order: string[] = [];
      const handler = createShutdownHandler({
        settings: { drainMs: 10, timeoutMs: 5_000 },
        steps: [{ name: "database pools", run: async () => void order.push("pools") }],
        exit: (code) => order.push(`exit ${code}`),
        log: () => undefined,
      });
      const started = Date.now();
      const stopping = handler("SIGTERM");
      const r = await report;
      order.push("tick answered");
      await stopping;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(order).toEqual(["tick answered", "pools", "exit 0"]);
      expect(attempts).toBe(1);
      // The running job completed with its continuation; the batch's other job (two 20 s
      // attempts fit in the budget) was handed back unrun, and the third was never claimed.
      expect(r).toMatchObject({ claimed: 1, succeeded: 1, continued: 1, released: 1 });
      expect(r.stoppedBy).toBe("draining");
      const left = await store.listJobs({ kind, status: "queued" });
      expect(left.map((j) => j.attempts)).toEqual([0, 0, 0]);
    } finally {
      resetJobRegistry();
      resetJobStore();
    }
  });
});

describe("readiness while stopping", () => {
  it("/api/health/ready answers 503 draining while every probe is healthy; live stays 200", async () => {
    bootHealthy();
    expect((await ready()).status).toBe(200);
    markDraining();
    const res = await ready();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "unready",
      ready: false,
      boot: "completed",
      draining: true,
      checks: [],
    });
    expect((await live()).status).toBe(200);
    const combined = await health();
    expect(await combined.json()).toMatchObject({ ready: false, draining: true });
  });

  it("a stop that begins while the probes run wins", async () => {
    let release: () => void = () => undefined;
    initObservability({
      environment: "test",
      version: PLATFORM_VERSION,
      healthProbes: [
        {
          name: "database",
          check: () =>
            new Promise((resolve) => {
              release = () =>
                resolve({
                  name: "database",
                  status: "healthy",
                  checkedAt: new Date().toISOString(),
                });
            }),
        },
      ],
    });
    recordBootCompleted();
    const pending = checkReadiness();
    await new Promise((r) => setImmediate(r));
    markDraining();
    release();
    expect(await pending).toMatchObject({
      ready: false,
      status: "unready",
      draining: true,
    });
  });

  it("reports not draining before any signal", async () => {
    bootHealthy();
    expect(await checkReadiness()).toMatchObject({ ready: true, draining: false });
  });
});

describe("the platform's steps", () => {
  it("flush metrics before the pools close, then close the cache and the pools", async () => {
    const order: string[] = [];
    const sink: MetricsSink & { destroy: () => void } = {
      record: () => undefined,
      flush: async () => void order.push("metrics flushed"),
      query: async () => [],
      destroy: () => void order.push("metrics timer stopped"),
    };
    bootHealthy({ metricsSink: sink });
    const cache = getCache();
    expect(cache).toBeInstanceOf(InMemoryCacheProvider);
    await cache.set("k", "v");
    const close = jest.spyOn(cache as InMemoryCacheProvider, "close");
    await setDataPoolFactory(
      async () =>
        ({
          end: async () => void order.push("pool closed"),
        }) as unknown as Pool
    );
    await getPool("request");
    await getPool("owner");

    const steps = platformShutdownSteps();
    expect(steps.map((s) => s.name)).toEqual(["telemetry", "cache", "database pools"]);
    for (const step of steps) await step.run();

    expect(order).toEqual([
      "metrics timer stopped",
      "metrics flushed",
      "pool closed",
      "pool closed",
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await cache.get("k")).toBeNull();
    // The cache is forgotten: a later getCache() builds a new one.
    expect(getCache()).not.toBe(cache);
    await setDataPoolFactory(
      async () => ({ end: async () => undefined }) as unknown as Pool
    );
  });

  it("telemetry is a no-op when observability never initialised; closing no cache is fine", async () => {
    const [telemetry] = platformShutdownSteps();
    await expect(telemetry.run()).resolves.toBeUndefined();
    await closeCache();
    await expect(closeCache()).resolves.toBeUndefined();
  });
});

describe("installing the handlers", () => {
  function fakeProcess() {
    const listeners = new Map<string, (signal: string) => void>();
    const exits: number[] = [];
    const target: SignalTarget = {
      on: (signal, listener) => listeners.set(signal, listener),
      exit: (code) => void exits.push(code),
    };
    return { target, listeners, exits };
  }

  it("installs nothing where Next.js keeps the signals (NEXT_MANUAL_SIG_HANDLE unset)", () => {
    const p = fakeProcess();
    expect(ownsSignals({})).toBe(false);
    expect(installShutdownHandlers(p.target, {})).toBe(false);
    expect(p.listeners.size).toBe(0);
  });

  it("only the value true hands the signals over", () => {
    expect(ownsSignals({ NEXT_MANUAL_SIG_HANDLE: "true" })).toBe(true);
    expect(ownsSignals({ NEXT_MANUAL_SIG_HANDLE: "1" })).toBe(false);
  });

  it("installs on SIGTERM and SIGINT, once per process, and a signal stops the instance", async () => {
    const env = {
      NEXT_MANUAL_SIG_HANDLE: "true",
      SHUTDOWN_DRAIN_SECONDS: "0",
      SHUTDOWN_TIMEOUT_SECONDS: "5",
    };
    const p = fakeProcess();
    expect(installShutdownHandlers(p.target, env)).toBe(true);
    expect([...p.listeners.keys()]).toEqual(["SIGTERM", "SIGINT"]);
    const again = fakeProcess();
    expect(installShutdownHandlers(again.target, env)).toBe(true);
    expect(again.listeners.size).toBe(0);

    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    p.listeners.get("SIGTERM")!("SIGTERM");
    expect(isDraining()).toBe(true);
    for (let i = 0; i < 50 && p.exits.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(p.exits).toEqual([0]);
    expect(log).toHaveBeenCalledWith(
      "[shutdown] SIGTERM received — not ready; draining for 0 ms (bound 5000 ms)"
    );
    log.mockRestore();
  });
});
