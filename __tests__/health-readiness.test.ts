/**
 * @jest-environment node
 */
/**
 * Liveness and readiness (ADR-056 D4, TASK-142): /api/health/live asks nothing; /api/health/ready
 * is ready only when boot completed and the required probes (database, selected cache) answer,
 * degraded — still ready — when only optional probes (realtime, modules) fail, and unready
 * otherwise. Probes are bounded; responses carry names and statuses, never detail.
 *
 * Hostile cases: observability never initialised, a boot that failed half way, a probe that
 * hangs, a probe that throws, a probe whose detail names a host and a credential.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "ready-req-id",
}));

import { GET as live } from "@/app/api/health/live/route";
import { GET as ready } from "@/app/api/health/ready/route";
import { GET as health } from "@/app/api/health/route";
import {
  HealthRegistry,
  initObservability,
  resetObservability,
  type HealthCheckResult,
  type HealthProbe,
} from "@/platform/observability";
import {
  getBootState,
  recordBootCompleted,
  recordBootFailed,
  recordBootStep,
  resetBootState,
} from "@/platform/observability/boot";
import { checkReadiness } from "@/platform/observability/readiness";
import { createCacheReadinessProbe, InMemoryCacheProvider } from "@/platform/cache";
import type { CacheProvider } from "@/platform/cache/types";
import { createRealtimeServiceProbe } from "@/platform/realtime/service-probe";
import { PLATFORM_VERSION } from "@/platform/version";

const probe = (
  name: string,
  status: HealthCheckResult["status"],
  detail = "detail: db.internal.example:port-sentinel password=hunter2"
): HealthProbe => ({
  name,
  check: async () => ({ name, status, detail, checkedAt: new Date().toISOString() }),
});
const hanging = (name: string): HealthProbe => ({
  name,
  check: () => new Promise(() => {}),
});

function boot(required: HealthProbe[], optional: HealthProbe[] = []) {
  initObservability({
    environment: "test",
    version: PLATFORM_VERSION,
    healthProbes: required,
    degradedOnlyProbes: optional,
  });
  recordBootCompleted();
}

beforeEach(() => {
  resetObservability();
  resetBootState();
});
afterAll(() => {
  resetObservability();
  resetBootState();
});

describe("GET /api/health/live", () => {
  it("answers 200 with nothing initialised and no dependency asked", async () => {
    const res = await live();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "live", version: PLATFORM_VERSION });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/health/ready", () => {
  it("is unready (503) when observability never initialised", async () => {
    const res = await ready();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "unready",
      ready: false,
      boot: "not_started",
      checks: [],
    });
  });

  it("is ready (200) when boot completed and every probe answers", async () => {
    boot(
      [probe("database", "healthy"), probe("cache", "healthy")],
      [probe("realtime", "healthy")]
    );
    const res = await ready();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ready",
      ready: true,
      boot: "completed",
      bootStep: null,
    });
    expect(
      body.checks.map((c: { name: string; required: boolean }) => [c.name, c.required])
    ).toEqual([
      ["database", true],
      ["cache", true],
      ["realtime", false],
    ]);
  });

  it("stays ready but degraded when only an optional probe fails", async () => {
    boot(
      [probe("database", "healthy")],
      [probe("realtime", "unhealthy"), probe("song-id", "degraded")]
    );
    const res = await ready();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("degraded");
  });

  it("is unready when a required probe fails, and never says why in the answer", async () => {
    boot([probe("database", "unhealthy"), probe("cache", "healthy")]);
    const res = await ready();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      status: "unready",
      ready: false,
      boot: "completed",
    });
    // Sentinels, not bare numbers: a timestamp in the answer could hold "5432".
    expect(text).not.toMatch(/hunter2|internal\.example|port-sentinel|detail/);
  });

  it("is unready when boot failed, naming the step, even if every probe answers", async () => {
    initObservability({
      environment: "test",
      version: "x",
      healthProbes: [probe("database", "healthy")],
    });
    recordBootStep("modules");
    recordBootStep("jobs");
    recordBootFailed();
    const res = await ready();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      boot: "failed",
      bootStep: "jobs",
      ready: false,
    });
  });

  it("is unready while boot is still running", async () => {
    initObservability({ environment: "test", version: "x" });
    recordBootStep("providers");
    const res = await ready();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ boot: "starting", bootStep: "providers" });
  });

  it("bounds a hanging required probe: unready within the timeout", async () => {
    // On the timer the bound uses, not the wall clock (review 10 L11): the answer comes when the
    // 200 ms timeout fires, not before, and the probe never answers at all.
    jest.useFakeTimers();
    let r!: Awaited<ReturnType<typeof checkReadiness>>;
    try {
      boot([hanging("database")]);
      let settled = false;
      const pending = checkReadiness(200).then((v) => {
        settled = true;
        r = v;
      });
      await jest.advanceTimersByTimeAsync(150);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(100);
      await pending;
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
    expect(r).toMatchObject({ ready: false, status: "unready" });
    expect(r.checks[0]).toMatchObject({
      name: "database",
      status: "unhealthy",
      required: true,
    });
  });

  it("bounds a hanging optional probe: still ready, degraded", async () => {
    boot([probe("database", "healthy")], [hanging("realtime")]);
    const r = await checkReadiness(200);
    expect(r).toMatchObject({ ready: true, status: "degraded" });
  });

  it("treats a probe that throws as unhealthy", async () => {
    boot([
      {
        name: "database",
        check: async () => {
          throw new Error("ECONNREFUSED 10.0.0.1");
        },
      },
    ]);
    expect((await ready()).status).toBe(503);
  });
});

describe("GET /api/health (kept for existing monitors)", () => {
  it("reports an unhealthy optional probe as degraded (200), each check saying if it is required", async () => {
    boot([probe("database", "healthy")], [probe("song-id", "unhealthy")]);
    const res = await health();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "degraded", ready: true, boot: "completed" });
    expect(body.checks).toEqual([
      expect.objectContaining({ name: "database", required: true }),
      expect.objectContaining({ name: "song-id", required: false, status: "unhealthy" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("still answers 503 when a required probe is unhealthy", async () => {
    boot([probe("database", "unhealthy")]);
    const res = await health();
    expect(res.status).toBe(503);
    expect((await res.json()).ready).toBe(false);
  });
});

describe("HealthRegistry, required and optional", () => {
  it("registers probes as required unless told otherwise", async () => {
    const r = new HealthRegistry("1");
    r.register(probe("a", "unhealthy"));
    r.register(probe("b", "healthy"), { required: false });
    const report = await r.check();
    expect(report.status).toBe("unhealthy");
    expect(report.checks.map((c) => c.required)).toEqual([true, false]);
  });

  it("makes an unhealthy optional probe degrade, never fail, the report", async () => {
    const r = new HealthRegistry("1");
    r.register(probe("a", "healthy"));
    r.register(probe("b", "unhealthy"), { required: false });
    expect((await r.check()).status).toBe("degraded");
  });
});

describe("the boot record", () => {
  it("moves from not started through each step to completed", () => {
    expect(getBootState().phase).toBe("not_started");
    recordBootStep("modules");
    expect(getBootState()).toMatchObject({ phase: "starting", step: "modules" });
    recordBootCompleted();
    expect(getBootState()).toMatchObject({ phase: "completed", step: null });
  });

  it("records a failure before any step as unknown", () => {
    recordBootFailed();
    expect(getBootState()).toMatchObject({ phase: "failed", step: "unknown" });
  });
});

describe("the cache readiness probe", () => {
  it("is healthy for a cache that answers (the in-memory cache always does)", async () => {
    const r = await createCacheReadinessProbe(new InMemoryCacheProvider()).check();
    expect(r).toMatchObject({ name: "cache", status: "healthy" });
  });

  it("is unhealthy for a cache that does not answer, or throws", async () => {
    const down = {
      name: "redis",
      health: async () => ({
        connected: false,
        latencyMs: 5,
        provider: "redis",
        error: "timeout",
      }),
    } as unknown as CacheProvider;
    const throws = {
      name: "redis",
      health: async () => {
        throw new Error("boom");
      },
    } as unknown as CacheProvider;
    expect((await createCacheReadinessProbe(down).check()).status).toBe("unhealthy");
    expect((await createCacheReadinessProbe(throws).check()).status).toBe("unhealthy");
  });
});

describe("the realtime service probe", () => {
  it("has nothing to reach with the mock provider", async () => {
    const fetchImpl = jest.fn();
    const r = await createRealtimeServiceProbe("mock", undefined, fetchImpl).check();
    expect(r.status).toBe("healthy");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is reachable on any HTTP answer, and unhealthy on none", async () => {
    const answers = jest.fn(async () => new Response("", { status: 426 }));
    const r = await createRealtimeServiceProbe(
      "supabase",
      "https://ref.supabase.co/",
      answers as never
    ).check(500);
    expect(r.status).toBe("healthy");
    expect(answers).toHaveBeenCalledWith(
      "https://ref.supabase.co/realtime/v1/",
      expect.objectContaining({ timeoutMs: 500, maxRetries: 0 })
    );
    const fails = jest.fn(async () => {
      throw new Error("fetch failed");
    });
    expect(
      (
        await createRealtimeServiceProbe(
          "supabase",
          "https://ref.supabase.co",
          fails as never
        ).check()
      ).status
    ).toBe("unhealthy");
  });

  it("is unhealthy when selected without its address", async () => {
    const r = await createRealtimeServiceProbe("supabase", undefined).check();
    expect(r.status).toBe("unhealthy");
  });
});

// Review finding 16: both health routes are unauthenticated and unthrottled, and each request ran
// every probe and sent an event to the error reporter per unhealthy probe — a flood of requests
// was a flood of probes and of events. One run now answers every request for HEALTH_CACHE_MS
// (single flight), and a probe's problem is reported when its state changes.
describe("the health routes under load", () => {
  const counting = (name: string, status: () => HealthCheckResult["status"]) => {
    const calls = { n: 0 };
    const p: HealthProbe = {
      name,
      check: async () => {
        calls.n++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          name,
          status: status(),
          detail: "x",
          checkedAt: new Date().toISOString(),
        };
      },
    };
    return { p, calls };
  };
  const reporter = () => {
    const captured: string[] = [];
    return {
      captured,
      errorReporter: {
        init: () => undefined,
        captureError: (e: Error) => void captured.push(e.message),
        captureMessage: () => undefined,
        setUser: () => undefined,
        flush: async () => true,
      } as never,
    };
  };

  it("runs the probes once for a burst of readiness and health requests (single flight)", async () => {
    const db = counting("database", () => "healthy");
    initObservability({
      environment: "test",
      version: PLATFORM_VERSION,
      healthProbes: [db.p],
    });
    recordBootCompleted();
    const answers = await Promise.all(Array.from({ length: 50 }, () => ready()));
    expect(answers).toHaveLength(50);
    expect(answers.every((r) => r.status === 200)).toBe(true);
    expect(db.calls.n).toBe(1);
    // /api/health shares the registry; its own bound is a separate run, once for its burst.
    await Promise.all(Array.from({ length: 20 }, () => health()));
    expect(db.calls.n).toBe(2);
  });

  it("runs them again once the shared answer is older than HEALTH_CACHE_MS", async () => {
    const { cachedHealthCheck, HEALTH_CACHE_MS } =
      await import("@/platform/observability/readiness");
    let t = 0;
    const registry = { check: jest.fn(async () => ({ status: "healthy" }) as never) };
    await cachedHealthCheck(registry, 3_000, () => t);
    t = HEALTH_CACHE_MS - 1;
    await cachedHealthCheck(registry, 3_000, () => t);
    expect(registry.check).toHaveBeenCalledTimes(1);
    t = HEALTH_CACHE_MS;
    await cachedHealthCheck(registry, 3_000, () => t);
    expect(registry.check).toHaveBeenCalledTimes(2);
    // A run that fails is not kept.
    registry.check.mockRejectedValueOnce(new Error("registry defect"));
    t = 2 * HEALTH_CACHE_MS;
    await expect(cachedHealthCheck(registry, 3_000, () => t)).rejects.toThrow();
    await cachedHealthCheck(registry, 3_000, () => t);
    expect(registry.check).toHaveBeenCalledTimes(4);
  });

  it("reports an unhealthy probe once per change of state, not once per request", async () => {
    let state: HealthCheckResult["status"] = "unhealthy";
    const cache = counting("cache", () => state);
    const r = reporter();
    initObservability({
      environment: "test",
      version: PLATFORM_VERSION,
      healthProbes: [cache.p],
      errorReporter: r.errorReporter,
    });
    recordBootCompleted();
    const { expireHealthCache } = await import("@/platform/observability/health-memo");
    for (let i = 0; i < 5; i++) {
      // A new run each time (as if HEALTH_CACHE_MS had passed), still unhealthy.
      expect((await ready()).status).toBe(503);
      expect((await health()).status).toBe(503);
      expireHealthCache();
    }
    expect(cache.calls.n).toBe(10);
    expect(r.captured).toHaveLength(1);
    expect(r.captured[0]).toMatch(/Health probe 'cache' is unhealthy/);
    // Recovered, then broken again: one more event.
    state = "healthy";
    expireHealthCache();
    expect((await ready()).status).toBe(200);
    state = "unhealthy";
    expireHealthCache();
    expect((await ready()).status).toBe(503);
    expect(r.captured).toHaveLength(2);
  });

  it("never caches draining: a stop is seen by the next request", async () => {
    const { markDraining, resetShutdownState } =
      await import("@/platform/observability/shutdown");
    const db = counting("database", () => "healthy");
    initObservability({
      environment: "test",
      version: PLATFORM_VERSION,
      healthProbes: [db.p],
    });
    recordBootCompleted();
    expect((await ready()).status).toBe(200);
    markDraining();
    try {
      const body = await (await ready()).json();
      expect(body).toMatchObject({ ready: false, draining: true });
    } finally {
      resetShutdownState();
    }
  });
});
