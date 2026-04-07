/**
 * __tests__/observability-tracing.test.ts — Distributed tracing tests
 *
 * Tests: trace creation, span lifecycle, header propagation,
 * span recording, ID generation.
 */

import {
  DefaultTraceProvider,
  generateTraceId,
  generateSpanId,
} from "@/platform/observability/tracing";

describe("generateTraceId", () => {
  it("generates a 32-character hex string (16 bytes)", () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateSpanId", () => {
  it("generates a 16-character hex string (8 bytes)", () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()));
    expect(ids.size).toBe(100);
  });
});

describe("DefaultTraceProvider", () => {
  let provider: DefaultTraceProvider;

  beforeEach(() => {
    provider = new DefaultTraceProvider();
  });

  describe("createTrace", () => {
    it("creates a root trace with traceId and spanId", () => {
      const trace = provider.createTrace();
      expect(trace.traceId).toHaveLength(32);
      expect(trace.spanId).toHaveLength(16);
      expect(trace.parentSpanId).toBeUndefined();
      expect(trace.startedAt).toBeTruthy();
    });

    it("creates unique traces", () => {
      const t1 = provider.createTrace();
      const t2 = provider.createTrace();
      expect(t1.traceId).not.toBe(t2.traceId);
      expect(t1.spanId).not.toBe(t2.spanId);
    });
  });

  describe("createSpan", () => {
    it("creates a child span with same traceId and parent link", () => {
      const trace = provider.createTrace();
      const span = provider.createSpan(trace, "ai.classify");

      expect(span.traceId).toBe(trace.traceId);
      expect(span.spanId).not.toBe(trace.spanId);
      expect(span.parentSpanId).toBe(trace.spanId);
      expect(span.startedAt).toBeTruthy();
    });

    it("supports nested spans (grandchild)", () => {
      const root = provider.createTrace();
      const child = provider.createSpan(root, "safety.check");
      const grandchild = provider.createSpan(child, "blocklist.scan");

      expect(grandchild.traceId).toBe(root.traceId);
      expect(grandchild.parentSpanId).toBe(child.spanId);
    });
  });

  describe("toHeaders / extractFromHeaders", () => {
    it("round-trips trace context through headers", () => {
      const trace = provider.createTrace();
      const headers = provider.toHeaders(trace);

      expect(headers["x-trace-id"]).toBe(trace.traceId);
      expect(headers["x-span-id"]).toBe(trace.spanId);

      const extracted = provider.extractFromHeaders(
        headers as unknown as Record<string, string>
      );
      expect(extracted).not.toBeNull();
      expect(extracted!.traceId).toBe(trace.traceId);
    });

    it("includes parent span ID in headers when present", () => {
      const root = provider.createTrace();
      const child = provider.createSpan(root, "child");
      const headers = provider.toHeaders(child);

      expect(headers["x-parent-span-id"]).toBe(root.spanId);
    });

    it("returns null when no trace header is present", () => {
      const result = provider.extractFromHeaders({});
      expect(result).toBeNull();
    });

    it("generates a new spanId when only traceId is in headers", () => {
      const result = provider.extractFromHeaders({
        "x-trace-id": "abc123",
      });
      expect(result).not.toBeNull();
      expect(result!.traceId).toBe("abc123");
      expect(result!.spanId).toBeTruthy();
    });
  });

  describe("endSpan", () => {
    it("records a completed span with duration", async () => {
      const trace = provider.createTrace();
      const span = provider.createSpan(trace, "ai.classify");

      // Small delay to ensure measurable duration
      await new Promise((r) => setTimeout(r, 10));

      const recorded = provider.endSpan(span, "ai.classify", "ok", {
        model: "haiku",
        tokens: 150,
      });

      expect(recorded.name).toBe("ai.classify");
      expect(recorded.traceId).toBe(trace.traceId);
      expect(recorded.spanId).toBe(span.spanId);
      expect(recorded.parentSpanId).toBe(trace.spanId);
      expect(recorded.status).toBe("ok");
      expect(recorded.durationMs).toBeGreaterThanOrEqual(0);
      expect(recorded.attributes.model).toBe("haiku");
      expect(recorded.attributes.tokens).toBe(150);
    });

    it("stores recorded spans", () => {
      const trace = provider.createTrace();
      provider.endSpan(trace, "op1", "ok");
      provider.endSpan(trace, "op2", "error");

      const spans = provider.getRecordedSpans();
      expect(spans).toHaveLength(2);
      expect(spans[0].name).toBe("op1");
      expect(spans[1].name).toBe("op2");
      expect(spans[1].status).toBe("error");
    });

    it("clearSpans resets the buffer", () => {
      const trace = provider.createTrace();
      provider.endSpan(trace, "op1", "ok");
      expect(provider.getRecordedSpans()).toHaveLength(1);

      provider.clearSpans();
      expect(provider.getRecordedSpans()).toHaveLength(0);
    });
  });
});
