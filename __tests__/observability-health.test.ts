/**
 * __tests__/observability-health.test.ts — Health check tests
 *
 * Tests: HealthRegistry aggregation, HttpHealthProbe, PostgresHealthProbe (platform/data mocked;
 * the real query runs in __tests__/db/health-probe.db.test.ts), timeout handling,
 * worst-status logic, duplicate probe rejection.
 */

import {
  HealthRegistry,
  HttpHealthProbe,
  PostgresHealthProbe,
} from "@/platform/observability/health";
import { hasDatabase, withPlatformTx } from "@/platform/data";

jest.mock("@/platform/data", () => ({
  hasDatabase: jest.fn(),
  withPlatformTx: jest.fn(),
}));
const mockHasDatabase = hasDatabase as jest.MockedFunction<typeof hasDatabase>;
const mockWithPlatformTx = withPlatformTx as jest.MockedFunction<typeof withPlatformTx>;
import type { HealthProbe, HealthCheckResult } from "@/platform/observability/types";

// ---------------------------------------------------------------------------
// Test helpers — mock probes
// ---------------------------------------------------------------------------

class MockHealthyProbe implements HealthProbe {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async check(): Promise<HealthCheckResult> {
    return {
      name: this.name,
      status: "healthy",
      latencyMs: 5,
      detail: "OK",
      checkedAt: new Date().toISOString(),
    };
  }
}

class MockDegradedProbe implements HealthProbe {
  readonly name = "degraded-service";
  async check(): Promise<HealthCheckResult> {
    return {
      name: this.name,
      status: "degraded",
      latencyMs: 2000,
      detail: "Slow response",
      checkedAt: new Date().toISOString(),
    };
  }
}

class MockUnhealthyProbe implements HealthProbe {
  readonly name = "dead-service";
  async check(): Promise<HealthCheckResult> {
    return {
      name: this.name,
      status: "unhealthy",
      detail: "Connection refused",
      checkedAt: new Date().toISOString(),
    };
  }
}

class MockThrowingProbe implements HealthProbe {
  readonly name = "throwing-service";
  async check(): Promise<HealthCheckResult> {
    throw new Error("Unexpected crash");
  }
}

class MockSlowProbe implements HealthProbe {
  readonly name = "slow-service";
  async check(): Promise<HealthCheckResult> {
    await new Promise((r) => setTimeout(r, 5000));
    return {
      name: this.name,
      status: "healthy",
      latencyMs: 5000,
      detail: "Eventually OK",
      checkedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HealthRegistry", () => {
  it("returns healthy when no probes registered", async () => {
    const registry = new HealthRegistry("1.0.0");
    const report = await registry.check();

    expect(report.status).toBe("healthy");
    expect(report.checks).toHaveLength(0);
    expect(report.version).toBe("1.0.0");
    expect(report.timestamp).toBeTruthy();
  });

  it("returns healthy when all probes are healthy", async () => {
    const registry = new HealthRegistry("1.0.0");
    registry.register(new MockHealthyProbe("db"));
    registry.register(new MockHealthyProbe("cache"));

    const report = await registry.check();
    expect(report.status).toBe("healthy");
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0].status).toBe("healthy");
    expect(report.checks[1].status).toBe("healthy");
  });

  it("returns degraded when any probe is degraded", async () => {
    const registry = new HealthRegistry("1.0.0");
    registry.register(new MockHealthyProbe("db"));
    registry.register(new MockDegradedProbe());

    const report = await registry.check();
    expect(report.status).toBe("degraded");
  });

  it("returns unhealthy when any probe is unhealthy", async () => {
    const registry = new HealthRegistry("1.0.0");
    registry.register(new MockHealthyProbe("db"));
    registry.register(new MockDegradedProbe());
    registry.register(new MockUnhealthyProbe());

    const report = await registry.check();
    expect(report.status).toBe("unhealthy");
  });

  it("catches probe exceptions and reports unhealthy", async () => {
    const registry = new HealthRegistry("1.0.0");
    registry.register(new MockThrowingProbe());

    const report = await registry.check();
    expect(report.status).toBe("unhealthy");
    expect(report.checks[0].detail).toContain("Unexpected crash");
  });

  it("times out slow probes", async () => {
    jest.useFakeTimers();
    const registry = new HealthRegistry("1.0.0");
    registry.register(new MockSlowProbe());

    const checkPromise = registry.check(100); // 100ms timeout
    jest.advanceTimersByTime(200);
    const report = await checkPromise;

    expect(report.status).toBe("unhealthy");
    expect(report.checks[0].detail).toContain("timed out");
    jest.useRealTimers();
  });

  it("rejects duplicate probe names", () => {
    const registry = new HealthRegistry("1.0.0");
    registry.register(new MockHealthyProbe("db"));
    registry.register(new MockHealthyProbe("db")); // duplicate

    expect(registry.getProbeNames()).toEqual(["db"]);
  });

  it("runs all probes in parallel", async () => {
    // Asserted as work, not wall-clock time (review 10 L11): every probe is in flight before any
    // answers — each waits until all five have started, which only a parallel run lets happen.
    const registry = new HealthRegistry("1.0.0");
    let started = 0;
    let maxInFlight = 0;
    let inFlight = 0;
    let allStarted!: () => void;
    const gate = new Promise<void>((r) => (allStarted = r));
    for (let i = 0; i < 5; i++) {
      const probe = new MockHealthyProbe(`service-${i}`);
      const check = probe.check.bind(probe);
      probe.check = async () => {
        started += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (started === 5) allStarted();
        await gate;
        inFlight -= 1;
        return check();
      };
      registry.register(probe);
    }

    const report = await registry.check();

    expect(report.checks).toHaveLength(5);
    expect(maxInFlight).toBe(5);
  });

  it("getProbeNames returns registered names", () => {
    const registry = new HealthRegistry("1.0.0");
    registry.register(new MockHealthyProbe("db"));
    registry.register(new MockHealthyProbe("cache"));
    registry.register(new MockHealthyProbe("llm"));

    expect(registry.getProbeNames()).toEqual(["db", "cache", "llm"]);
  });
});

describe("HttpHealthProbe", () => {
  it("has the correct name", () => {
    const probe = new HttpHealthProbe("my-service", "http://localhost:9999/health");
    expect(probe.name).toBe("my-service");
  });

  it("reports unhealthy on connection failure", async () => {
    const probe = new HttpHealthProbe("unreachable", "http://localhost:1/health");
    const result = await probe.check(500);

    expect(result.name).toBe("unreachable");
    expect(result.status).toBe("unhealthy");
    expect(result.detail).toBeTruthy();
  });
});

describe("CachedHealthProbe (audit X-13)", () => {
  const { CachedHealthProbe } = require("@/platform/observability/health");
  const result = (status: string) => ({ name: "paid", status, checkedAt: "t" });

  it("runs the wrapped probe at most once per interval", async () => {
    let t = 0;
    const inner = { name: "paid", check: jest.fn(async () => result("healthy")) };
    const probe = new CachedHealthProbe(inner, 60_000, () => t);
    for (let i = 0; i < 100; i += 1) await probe.check();
    expect(inner.check).toHaveBeenCalledTimes(1);
    t = 60_001;
    await probe.check();
    expect(inner.check).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight call between concurrent checks", async () => {
    let release: (v: unknown) => void = () => {};
    const inner = {
      name: "paid",
      check: jest.fn(() => new Promise((r) => (release = r))),
    };
    const probe = new CachedHealthProbe(inner, 60_000);
    const checks = Array.from({ length: 20 }, () => probe.check());
    release(result("degraded"));
    const results = await Promise.all(checks);
    expect(inner.check).toHaveBeenCalledTimes(1);
    expect(results.every((r: { status: string }) => r.status === "degraded")).toBe(true);
  });

  it("caches an unhealthy result too, so an outage does not multiply calls", async () => {
    const inner = { name: "paid", check: jest.fn(async () => result("unhealthy")) };
    const probe = new CachedHealthProbe(inner, 60_000);
    await probe.check();
    await probe.check();
    expect(inner.check).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-positive interval", () => {
    expect(() => new CachedHealthProbe({ name: "x", check: jest.fn() }, 0)).toThrow();
  });
});

describe("PostgresHealthProbe", () => {
  afterEach(() => {
    jest.useRealTimers();
    mockHasDatabase.mockReset();
    mockWithPlatformTx.mockReset();
  });

  it("is healthy when select 1 answers, in a platform transaction", async () => {
    mockHasDatabase.mockReturnValue(true);
    const query = jest.fn(async () => ({ rows: [{ "?column?": 1 }], rowCount: 1 }));
    mockWithPlatformTx.mockImplementation(async (fn) =>
      fn({ query, tenantId: undefined } as never)
    );
    const r = await new PostgresHealthProbe().check();
    expect(r).toMatchObject({ name: "database", status: "healthy", detail: "OK" });
    expect(typeof r.latencyMs).toBe("number");
    expect(typeof r.checkedAt).toBe("string");
    expect(query).toHaveBeenCalledWith("select 1");
  });

  it("is unhealthy when no database is configured, without trying", async () => {
    mockHasDatabase.mockReturnValue(false);
    const r = await new PostgresHealthProbe().check();
    expect(r).toMatchObject({ name: "database", status: "unhealthy" });
    expect(r.detail).toMatch(/No database configured/);
    expect(mockWithPlatformTx).not.toHaveBeenCalled();
  });

  it("is unhealthy when the query fails", async () => {
    mockHasDatabase.mockReturnValue(true);
    mockWithPlatformTx.mockRejectedValue(
      new Error("No database connection could be had")
    );
    const r = await new PostgresHealthProbe().check();
    expect(r).toMatchObject({
      status: "unhealthy",
      detail: "No database connection could be had",
    });
  });

  it("reports a non-Error failure as text", async () => {
    mockHasDatabase.mockReturnValue(true);
    mockWithPlatformTx.mockRejectedValue("boom");
    await expect(new PostgresHealthProbe().check()).resolves.toMatchObject({
      status: "unhealthy",
      detail: "boom",
    });
  });

  it("is unhealthy when the database does not answer within the timeout", async () => {
    jest.useFakeTimers();
    mockHasDatabase.mockReturnValue(true);
    mockWithPlatformTx.mockReturnValue(new Promise(() => {}));
    const pending = new PostgresHealthProbe().check(250);
    jest.advanceTimersByTime(250);
    await expect(pending).resolves.toMatchObject({
      status: "unhealthy",
      detail: "Database did not answer within 250ms",
    });
  });
});
