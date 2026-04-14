/**
 * Sprint 6 — Integration: Observability Pipeline
 *
 * Tests the observability fabric end-to-end:
 * tracing → metrics sink → health registry → error reporting.
 * Verifies Sprint 3 components work together.
 */

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("Observability Pipeline Integration", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe("Tracing → context propagation", () => {
    it("createTrace produces a valid trace context", async () => {
      const { DefaultTraceProvider } = await import("@/platform/observability/tracing");
      const tracer = new DefaultTraceProvider();
      const trace = tracer.createTrace();
      expect(trace.traceId).toBeTruthy();
      expect(trace.spanId).toBeTruthy();
    });

    it("createSpan inherits parent traceId", async () => {
      const { DefaultTraceProvider } = await import("@/platform/observability/tracing");
      const tracer = new DefaultTraceProvider();
      const trace = tracer.createTrace();
      const span = tracer.createSpan(trace, "test-operation");
      expect(span.traceId).toBe(trace.traceId);
      expect(span.spanId).not.toBe(trace.spanId);
    });

    it("multiple spans share the same traceId", async () => {
      const { DefaultTraceProvider } = await import("@/platform/observability/tracing");
      const tracer = new DefaultTraceProvider();
      const trace = tracer.createTrace();
      const span1 = tracer.createSpan(trace, "op-1");
      const span2 = tracer.createSpan(trace, "op-2");
      expect(span1.traceId).toBe(span2.traceId);
      expect(span1.spanId).not.toBe(span2.spanId);
    });
  });

  describe("Metrics sink records and queries", () => {
    it("InMemoryMetricsSink stores and retrieves metrics", async () => {
      const { InMemoryMetricsSink } =
        await import("@/platform/observability/metrics-sink");
      const sink = new InMemoryMetricsSink();

      sink.record({
        name: "ai.call.latency",
        values: { latencyMs: 150 },
        tags: { useCase: "translate", model: "haiku" },
        timestamp: new Date().toISOString(),
      });

      sink.record({
        name: "ai.call.latency",
        values: { latencyMs: 200 },
        tags: { useCase: "classify", model: "haiku" },
        timestamp: new Date().toISOString(),
      });

      const all = await sink.query({ name: "ai.call.latency" });
      expect(all).toHaveLength(2);

      const translateOnly = await sink.query({
        name: "ai.call.latency",
        tags: { useCase: "translate" },
      });
      expect(translateOnly).toHaveLength(1);
      expect(translateOnly[0].values.latencyMs).toBe(150);
    });
  });

  describe("Health registry aggregates probes", () => {
    it("registers and checks multiple probes", async () => {
      const { HealthRegistry } = await import("@/platform/observability/health");

      const registry = new HealthRegistry("test-v1");

      registry.register({
        name: "database",
        async check() {
          return {
            name: "database",
            status: "healthy" as const,
            latencyMs: 5,
            checkedAt: new Date().toISOString(),
          };
        },
      });

      registry.register({
        name: "ai-provider",
        async check() {
          return {
            name: "ai-provider",
            status: "healthy" as const,
            latencyMs: 50,
            checkedAt: new Date().toISOString(),
          };
        },
      });

      const report = await registry.check();
      expect(report.status).toBe("healthy");
      expect(report.checks).toHaveLength(2);
      expect(report.version).toBe("test-v1");
    });

    it("reports unhealthy when any probe fails", async () => {
      const { HealthRegistry } = await import("@/platform/observability/health");

      const registry = new HealthRegistry("test-v1");

      registry.register({
        name: "healthy-service",
        async check() {
          return {
            name: "healthy-service",
            status: "healthy" as const,
            checkedAt: new Date().toISOString(),
          };
        },
      });

      registry.register({
        name: "broken-service",
        async check() {
          return {
            name: "broken-service",
            status: "unhealthy" as const,
            detail: "connection refused",
            checkedAt: new Date().toISOString(),
          };
        },
      });

      const report = await registry.check();
      expect(report.status).toBe("unhealthy");
      const broken = report.checks.find(
        (c: { name: string }) => c.name === "broken-service"
      );
      expect(broken?.status).toBe("unhealthy");
    });

    it("rejects duplicate probe names", async () => {
      const { HealthRegistry } = await import("@/platform/observability/health");

      const registry = new HealthRegistry("test-v1");

      registry.register({
        name: "service-a",
        async check() {
          return {
            name: "service-a",
            status: "healthy" as const,
            checkedAt: new Date().toISOString(),
          };
        },
      });

      registry.register({
        name: "service-a",
        async check() {
          return {
            name: "service-a",
            status: "unhealthy" as const,
            checkedAt: new Date().toISOString(),
          };
        },
      });

      const report = await registry.check();
      expect(report.checks).toHaveLength(1);
    });
  });

  describe("Error reporter", () => {
    it("NoopErrorReporter silently accepts errors", async () => {
      const { NoopErrorReporter } =
        await import("@/platform/observability/error-reporting");

      const reporter = new NoopErrorReporter();
      reporter.init();
      expect(() => reporter.captureError(new Error("test"))).not.toThrow();
      expect(() => reporter.captureMessage("test message", "warning")).not.toThrow();
    });
  });

  describe("Cross-module: health + metrics", () => {
    it("health probe can report metrics sink state", async () => {
      const { HealthRegistry } = await import("@/platform/observability/health");
      const { InMemoryMetricsSink } =
        await import("@/platform/observability/metrics-sink");

      const registry = new HealthRegistry("test-v1");
      const sink = new InMemoryMetricsSink();

      sink.record({
        name: "test.metric",
        values: { count: 1 },
        tags: {},
        timestamp: new Date().toISOString(),
      });

      registry.register({
        name: "metrics",
        async check() {
          const count = (await sink.query({})).length;
          return {
            name: "metrics",
            status: "healthy" as const,
            detail: "metrics count: " + count,
            checkedAt: new Date().toISOString(),
          };
        },
      });

      const report = await registry.check();
      expect(report.status).toBe("healthy");
    });
  });
});
