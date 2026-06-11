/**
 * __tests__/contract/trace-provider-contract.ts
 * TraceProvider conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type { TraceProvider } from "@/platform/observability/types";

const ISO = /^\d{4}-\d{2}-\d{2}T/;

export interface TraceContractFixtures {
  makeProvider: () => TraceProvider | Promise<TraceProvider>;
}

export function runTraceProviderContract(fx: TraceContractFixtures): void {
  let tracer: TraceProvider;

  beforeEach(async () => {
    tracer = await fx.makeProvider();
  });

  describe("createTrace", () => {
    it("returns a root context with ids and a start time", () => {
      const ctx = tracer.createTrace();
      expect(typeof ctx.traceId).toBe("string");
      expect(ctx.traceId.length).toBeGreaterThan(0);
      expect(typeof ctx.spanId).toBe("string");
      expect(ctx.spanId.length).toBeGreaterThan(0);
      expect(ctx.startedAt).toMatch(ISO);
    });
  });

  describe("createSpan", () => {
    it("creates a child sharing the trace and linking the parent", () => {
      const parent = tracer.createTrace();
      const child = tracer.createSpan(parent, "child-op");
      expect(child.traceId).toBe(parent.traceId);
      expect(child.parentSpanId).toBe(parent.spanId);
      expect(child.spanId).not.toBe(parent.spanId);
    });
  });

  describe("headers", () => {
    it("round-trips trace context through headers", () => {
      const ctx = tracer.createTrace();
      const headers = tracer.toHeaders(ctx);
      expect(headers["x-trace-id"]).toBe(ctx.traceId);
      expect(headers["x-span-id"]).toBe(ctx.spanId);
      const plain: Record<string, string | undefined> = {
        "x-trace-id": headers["x-trace-id"],
        "x-span-id": headers["x-span-id"],
        "x-parent-span-id": headers["x-parent-span-id"],
      };
      const extracted = tracer.extractFromHeaders(plain);
      expect(extracted).not.toBeNull();
      expect(extracted!.traceId).toBe(ctx.traceId);
    });

    it("returns null when no trace header is present", () => {
      const extracted = tracer.extractFromHeaders({});
      expect(extracted).toBeNull();
    });
  });

  describe("endSpan", () => {
    it("returns span data with a non-negative duration and given status", () => {
      const ctx = tracer.createTrace();
      const span = tracer.endSpan(ctx, "op", "ok", { k: "v" });
      expect(span.name).toBe("op");
      expect(span.traceId).toBe(ctx.traceId);
      expect(span.spanId).toBe(ctx.spanId);
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(span.status).toBe("ok");
      expect(typeof span.attributes).toBe("object");
    });
  });
}
