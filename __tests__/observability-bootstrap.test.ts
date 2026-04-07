/**
 * __tests__/observability-bootstrap.test.ts — Bootstrap integration tests
 *
 * Tests: initObservability, getObservability, tryGetObservability,
 * resetObservability, custom provider injection.
 */

import {
  initObservability,
  getObservability,
  tryGetObservability,
  resetObservability,
  DefaultTraceProvider,
  NoopErrorReporter,
  InMemoryMetricsSink,
} from "@/platform/observability";
import type {
  ErrorReporter,
  TraceProvider,
  MetricsSink,
  ObservabilityConfig,
} from "@/platform/observability/types";

// Suppress logger output in tests
beforeAll(() => {
  process.env.LOG_LEVEL = "silent";
});

afterEach(() => {
  resetObservability();
});

const baseConfig: ObservabilityConfig = {
  environment: "test",
  version: "1.0.0-test",
};

describe("initObservability", () => {
  it("initializes with default providers (no Sentry DSN)", () => {
    initObservability(baseConfig);

    const obs = getObservability();
    expect(obs.tracer).toBeInstanceOf(DefaultTraceProvider);
    expect(obs.errors).toBeInstanceOf(NoopErrorReporter);
    expect(obs.metrics).toBeInstanceOf(InMemoryMetricsSink);
    expect(obs.health).toBeTruthy();
  });

  it("registers health probes from config", () => {
    const mockProbe = {
      name: "test-probe",
      check: async () => ({
        name: "test-probe",
        status: "healthy" as const,
        latencyMs: 1,
        detail: "OK",
        checkedAt: new Date().toISOString(),
      }),
    };

    initObservability({
      ...baseConfig,
      healthProbes: [mockProbe],
    });

    const obs = getObservability();
    expect(obs.health.getProbeNames()).toEqual(["test-probe"]);
  });

  it("accepts custom error reporter", () => {
    const customReporter: ErrorReporter = {
      init: jest.fn(),
      captureError: jest.fn(),
      captureMessage: jest.fn(),
      setUser: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
    };

    initObservability({
      ...baseConfig,
      errorReporter: customReporter,
    });

    const obs = getObservability();
    expect(obs.errors).toBe(customReporter);
    expect(customReporter.init).toHaveBeenCalledTimes(1);
  });

  it("accepts custom trace provider", () => {
    const customTracer: TraceProvider = {
      createTrace: jest.fn(),
      createSpan: jest.fn(),
      extractFromHeaders: jest.fn(),
      toHeaders: jest.fn(),
      recordSpan: jest.fn(),
      endSpan: jest.fn(),
    };

    initObservability({
      ...baseConfig,
      traceProvider: customTracer,
    });

    const obs = getObservability();
    expect(obs.tracer).toBe(customTracer);
  });

  it("accepts custom metrics sink", () => {
    const customSink: MetricsSink = {
      record: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
    };

    initObservability({
      ...baseConfig,
      metricsSink: customSink,
    });

    const obs = getObservability();
    expect(obs.metrics).toBe(customSink);
  });

  it("allows reinitialization (logs warning but works)", () => {
    initObservability(baseConfig);
    const first = getObservability();

    initObservability({ ...baseConfig, version: "2.0.0" });
    const second = getObservability();

    // Should be a new instance
    expect(second).not.toBe(first);
  });
});

describe("getObservability", () => {
  it("throws before initialization", () => {
    expect(() => getObservability()).toThrow("Observability not initialized");
  });

  it("returns providers after initialization", () => {
    initObservability(baseConfig);

    const obs = getObservability();
    expect(obs.tracer).toBeTruthy();
    expect(obs.errors).toBeTruthy();
    expect(obs.metrics).toBeTruthy();
    expect(obs.health).toBeTruthy();
  });
});

describe("tryGetObservability", () => {
  it("returns null before initialization", () => {
    expect(tryGetObservability()).toBeNull();
  });

  it("returns providers after initialization", () => {
    initObservability(baseConfig);
    expect(tryGetObservability()).not.toBeNull();
  });
});

describe("resetObservability", () => {
  it("resets state so getObservability throws again", () => {
    initObservability(baseConfig);
    expect(() => getObservability()).not.toThrow();

    resetObservability();
    expect(() => getObservability()).toThrow();
  });
});

describe("end-to-end: trace → metric → error", () => {
  it("all providers work together in a request lifecycle", async () => {
    initObservability(baseConfig);
    const { tracer, metrics, errors } = getObservability();

    // 1. Create trace for incoming request
    const trace = tracer.createTrace();
    expect(trace.traceId).toBeTruthy();

    // 2. Create span for AI call
    const aiSpan = tracer.createSpan(trace, "ai.classify");
    expect(aiSpan.traceId).toBe(trace.traceId);
    expect(aiSpan.parentSpanId).toBe(trace.spanId);

    // 3. Record AI call metric
    metrics.record({
      name: "ai.call",
      timestamp: new Date().toISOString(),
      traceId: trace.traceId,
      values: { latencyMs: 150, inputTokens: 200, outputTokens: 50, costUsd: 0.002 },
      tags: { model: "haiku", useCase: "classify" },
    });

    // 4. Capture an error (no-op in test, but shouldn't throw)
    errors.captureError(new Error("test error"), {
      traceContext: trace,
      userId: "user-123",
    });

    // 5. Query metrics
    const results = await metrics.query({ name: "ai.call" });
    expect(results).toHaveLength(1);
    expect(results[0].traceId).toBe(trace.traceId);

    // 6. Flush
    await metrics.flush();
    await errors.flush();
  });
});
