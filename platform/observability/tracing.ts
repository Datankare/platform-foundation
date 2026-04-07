/**
 * platform/observability/tracing.ts — Distributed tracing
 *
 * ADR-014: Trace propagation across all external API calls.
 * Standing Rule 9: Every external integration instrumented from day one.
 *
 * DefaultTraceProvider generates trace/span IDs and propagates context
 * via x-trace-id / x-span-id headers. Consumers can swap to OpenTelemetry
 * or vendor-specific tracing by implementing the TraceProvider interface.
 *
 * Trace flow:
 *   API request arrives → createTrace() or extractFromHeaders()
 *   → each sub-operation gets createSpan()
 *   → outgoing calls include toHeaders()
 *   → completed operations call endSpan()
 */

import type {
  TraceContext,
  TraceHeaders,
  TraceProvider,
  SpanData,
  SpanStatus,
} from "./types";

// ---------------------------------------------------------------------------
// ID generation — crypto-safe hex IDs
// ---------------------------------------------------------------------------

function generateId(bytes: number): string {
  // Node.js crypto for server-side, Math.random fallback for edge/test
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    return Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Fallback — not cryptographically secure, but functional in tests
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0")
  ).join("");
}

/** Generate a 16-byte (128-bit) trace ID. */
export function generateTraceId(): string {
  return generateId(16);
}

/** Generate an 8-byte (64-bit) span ID. */
export function generateSpanId(): string {
  return generateId(8);
}

// ---------------------------------------------------------------------------
// Default Trace Provider
// ---------------------------------------------------------------------------

/**
 * DefaultTraceProvider — generates trace/span IDs, propagates via headers.
 *
 * This is a lightweight, zero-dependency implementation suitable for
 * serverless environments. It does not send traces to an external service
 * — that's the job of the ErrorReporter (Sentry Performance) or a custom
 * TraceProvider implementation (OpenTelemetry, Datadog APM).
 *
 * Recorded spans are stored in-memory for the request lifetime.
 * In Phase 3+, the ErrorReporter integration forwards spans to Sentry.
 */
export class DefaultTraceProvider implements TraceProvider {
  private readonly spans: SpanData[] = [];

  createTrace(): TraceContext {
    return {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      startedAt: new Date().toISOString(),
    };
  }

  createSpan(parent: TraceContext, name: string): TraceContext {
    return {
      traceId: parent.traceId,
      spanId: generateSpanId(),
      parentSpanId: parent.spanId,
      startedAt: new Date().toISOString(),
    };
  }

  extractFromHeaders(headers: Record<string, string | undefined>): TraceContext | null {
    const traceId = headers["x-trace-id"];
    const spanId = headers["x-span-id"];

    if (!traceId) return null;

    return {
      traceId,
      spanId: spanId ?? generateSpanId(),
      parentSpanId: headers["x-parent-span-id"],
      startedAt: new Date().toISOString(),
    };
  }

  toHeaders(context: TraceContext): TraceHeaders {
    const headers: TraceHeaders = {
      "x-trace-id": context.traceId,
      "x-span-id": context.spanId,
    };

    if (context.parentSpanId) {
      return { ...headers, "x-parent-span-id": context.parentSpanId };
    }

    return headers;
  }

  recordSpan(span: SpanData): void {
    this.spans.push(span);
  }

  endSpan(
    context: TraceContext,
    name: string,
    status: SpanStatus,
    attributes: Record<string, string | number | boolean> = {}
  ): SpanData {
    const now = new Date();
    const startedAt = new Date(context.startedAt);
    const durationMs = now.getTime() - startedAt.getTime();

    const span: SpanData = {
      name,
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      startedAt: context.startedAt,
      endedAt: now.toISOString(),
      durationMs: Math.max(0, durationMs),
      status,
      attributes,
    };

    this.recordSpan(span);
    return span;
  }

  /** Get all recorded spans — for tests and debugging. */
  getRecordedSpans(): readonly SpanData[] {
    return [...this.spans];
  }

  /** Clear recorded spans — for tests. */
  clearSpans(): void {
    this.spans.length = 0;
  }
}
