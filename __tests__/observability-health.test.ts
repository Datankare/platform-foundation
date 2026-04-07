/**
 * __tests__/observability-health.test.ts — Health check tests
 *
 * Tests: HealthRegistry aggregation, HttpHealthProbe, timeout handling,
 * worst-status logic, duplicate probe rejection.
 */

import { HealthRegistry, HttpHealthProbe } from "@/platform/observability/health";
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
    const registry = new HealthRegistry("1.0.0");
    for (let i = 0; i < 5; i++) {
      registry.register(new MockHealthyProbe(`service-${i}`));
    }

    const start = Date.now();
    const report = await registry.check();
    const duration = Date.now() - start;

    expect(report.checks).toHaveLength(5);
    // All probes run in parallel — total time should be ~1 probe, not 5x
    expect(duration).toBeLessThan(500);
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
