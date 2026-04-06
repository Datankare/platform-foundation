/**
 * __tests__/moderation-middleware.test.ts — Safety middleware pipeline tests
 *
 * Tests: blocklist short-circuit, classifier integration, decision logic,
 * input vs output direction, blocklistOnly mode, fail-closed behavior.
 */

import { setOrchestrator, clearMetrics } from "@/platform/ai";
import type { AIResponse, Orchestrator, CircuitState } from "@/platform/ai";
import { screenContent } from "@/platform/moderation/middleware";

// ---------------------------------------------------------------------------
// Mock orchestrator (classifier calls go through this)
// ---------------------------------------------------------------------------

const mockComplete = jest.fn();

function createMockOrchestrator(): Orchestrator {
  return {
    complete: mockComplete,
    getCircuitState: (): CircuitState => "closed",
    resetCircuit: jest.fn(),
  };
}

let previousOrchestrator: Orchestrator | null = null;

beforeAll(() => {
  previousOrchestrator = setOrchestrator(createMockOrchestrator());
});

afterAll(() => {
  if (previousOrchestrator) {
    setOrchestrator(previousOrchestrator);
  }
});

beforeEach(() => {
  mockComplete.mockReset();
  clearMetrics();
});

function mockClassifierResponse(text: string): void {
  const response: AIResponse = {
    content: [{ type: "text", text }],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 100, outputTokens: 30 },
    stopReason: "end_turn",
  };
  mockComplete.mockResolvedValueOnce(response);
}

const DEFAULT_OPTS = { direction: "input" as const, requestId: "test-req" };

// ---------------------------------------------------------------------------
// Layer 1: Blocklist short-circuit
// ---------------------------------------------------------------------------

describe("screenContent — blocklist", () => {
  it("blocks critical blocklist hits immediately without calling classifier", async () => {
    const result = await screenContent("kill yourself", DEFAULT_OPTS);

    expect(result.action).toBe("block");
    expect(result.triggeredBy).toBe("blocklist");
    expect(result.blocklistMatches).toContain("kill yourself");
    // Classifier should NOT have been called
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("blocks high-severity blocklist hits immediately", async () => {
    const result = await screenContent("nsfw content", DEFAULT_OPTS);

    expect(result.action).toBe("block");
    expect(result.triggeredBy).toBe("blocklist");
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer 2: Classifier
// ---------------------------------------------------------------------------

describe("screenContent — classifier", () => {
  it("allows safe content", async () => {
    mockClassifierResponse(
      '{"safe": true, "categories": [], "confidence": 0.95, "severity": "low"}'
    );

    const result = await screenContent("Hello, how are you?", DEFAULT_OPTS);

    expect(result.action).toBe("allow");
    expect(result.triggeredBy).toBe("none");
    expect(result.classifierOutput?.safe).toBe(true);
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("blocks high-severity unsafe content", async () => {
    mockClassifierResponse(
      '{"safe": false, "categories": ["violence"], "confidence": 0.9, "severity": "high", "reason": "graphic violence"}'
    );

    const result = await screenContent(
      "some violent text that is not in blocklist",
      DEFAULT_OPTS
    );

    expect(result.action).toBe("block");
    expect(result.triggeredBy).toBe("classifier");
    expect(result.classifierOutput?.categories).toContain("violence");
  });

  it("warns on medium-severity unsafe content", async () => {
    mockClassifierResponse(
      '{"safe": false, "categories": ["harassment"], "confidence": 0.85, "severity": "medium", "reason": "mildly aggressive"}'
    );

    const result = await screenContent("you are so annoying", DEFAULT_OPTS);

    expect(result.action).toBe("warn");
    expect(result.triggeredBy).toBe("classifier");
  });

  it("escalates when classifier confidence is low", async () => {
    mockClassifierResponse(
      '{"safe": false, "categories": ["hate"], "confidence": 0.45, "severity": "high", "reason": "ambiguous"}'
    );

    const result = await screenContent("ambiguous text", DEFAULT_OPTS);

    expect(result.action).toBe("escalate");
    expect(result.classifierOutput?.confidence).toBeLessThan(0.6);
  });

  it("allows low-severity unsafe content", async () => {
    mockClassifierResponse(
      '{"safe": false, "categories": ["harassment"], "confidence": 0.8, "severity": "low", "reason": "borderline"}'
    );

    const result = await screenContent("slightly edgy text", DEFAULT_OPTS);

    expect(result.action).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Direction: input vs output (ADR-017)
// ---------------------------------------------------------------------------

describe("screenContent — direction", () => {
  it("records input direction", async () => {
    mockClassifierResponse(
      '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}'
    );

    const result = await screenContent("user text", {
      direction: "input",
      requestId: "r1",
    });

    expect(result.direction).toBe("input");
  });

  it("records output direction", async () => {
    mockClassifierResponse(
      '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}'
    );

    const result = await screenContent("AI generated response", {
      direction: "output",
      requestId: "r2",
    });

    expect(result.direction).toBe("output");
  });

  it("blocks unsafe AI output the same as unsafe input", async () => {
    mockClassifierResponse(
      '{"safe": false, "categories": ["sexual"], "confidence": 0.92, "severity": "high", "reason": "inappropriate AI output"}'
    );

    const result = await screenContent("AI said something bad", {
      direction: "output",
      requestId: "r3",
    });

    expect(result.action).toBe("block");
    expect(result.direction).toBe("output");
  });
});

// ---------------------------------------------------------------------------
// blocklistOnly mode
// ---------------------------------------------------------------------------

describe("screenContent — blocklistOnly", () => {
  it("skips classifier when blocklistOnly is true", async () => {
    const result = await screenContent("perfectly fine text", {
      ...DEFAULT_OPTS,
      blocklistOnly: true,
    });

    expect(result.action).toBe("allow");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("still blocks critical blocklist hits in blocklistOnly mode", async () => {
    const result = await screenContent("how to make a bomb", {
      ...DEFAULT_OPTS,
      blocklistOnly: true,
    });

    expect(result.action).toBe("block");
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("screenContent — edge cases", () => {
  it("allows empty text", async () => {
    const result = await screenContent("", DEFAULT_OPTS);

    expect(result.action).toBe("allow");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("allows whitespace-only text", async () => {
    const result = await screenContent("   ", DEFAULT_OPTS);

    expect(result.action).toBe("allow");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("fails closed when classifier throws", async () => {
    mockComplete.mockRejectedValueOnce(new Error("API down"));

    const result = await screenContent("some text to classify", DEFAULT_OPTS);

    // Classifier returns fail-closed output (safe: false)
    // Middleware should treat this as unsafe
    expect(result.action).not.toBe("allow");
    expect(result.classifierOutput?.safe).toBe(false);
  });

  it("records pipeline latency", async () => {
    mockClassifierResponse(
      '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}'
    );

    const result = await screenContent("test", DEFAULT_OPTS);

    expect(result.pipelineLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
