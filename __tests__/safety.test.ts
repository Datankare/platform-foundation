/**
 * __tests__/safety.test.ts — Safety module tests (refactored for orchestrator)
 *
 * Phase 2: safety.ts now uses the orchestration layer (ADR-015).
 * Tests mock the orchestrator, not the Anthropic SDK directly.
 */

import { setOrchestrator, clearMetrics } from "@/platform/ai";
import type {
  AIRequest,
  AIResponse,
  Orchestrator,
  OrchestratorOptions,
  CircuitState,
} from "@/platform/ai";

// Create mock orchestrator before importing safety
const mockComplete = jest.fn();

function createMockOrchestrator(): Orchestrator {
  return {
    complete: mockComplete,
    getCircuitState: (): CircuitState => "closed",
    resetCircuit: jest.fn(),
  };
}

// Install mock orchestrator
let previousOrchestrator: Orchestrator | null = null;

beforeAll(() => {
  previousOrchestrator = setOrchestrator(createMockOrchestrator());
});

afterAll(() => {
  if (previousOrchestrator) {
    setOrchestrator(previousOrchestrator);
  }
});

// Import AFTER mock is set up
import { checkSafety, classifyContent } from "@/lib/safety";

beforeEach(() => {
  mockComplete.mockClear();
  clearMetrics();
});

// Helper: mock a successful orchestrator response with given text
function mockOrchestratorResponse(text: string): void {
  const response: AIResponse = {
    content: [{ type: "text", text }],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 100, outputTokens: 30 },
    stopReason: "end_turn",
  };
  mockComplete.mockResolvedValueOnce(response);
}

// ---------------------------------------------------------------------------
// classifyContent — structured output
// ---------------------------------------------------------------------------

describe("classifyContent", () => {
  it("returns structured safe result", async () => {
    mockOrchestratorResponse(
      '{"safe": true, "categories": [], "confidence": 0.95, "severity": "low"}'
    );
    const result = await classifyContent("Hello world");
    expect(result.safe).toBe(true);
    expect(result.categories).toEqual([]);
    expect(result.confidence).toBeCloseTo(0.95);
    expect(result.severity).toBe("low");
  });

  it("returns structured unsafe result with categories", async () => {
    mockOrchestratorResponse(
      '{"safe": false, "categories": ["violence", "hate"], "confidence": 0.87, "severity": "high", "reason": "graphic violence"}'
    );
    const result = await classifyContent("violent content");
    expect(result.safe).toBe(false);
    expect(result.categories).toContain("violence");
    expect(result.categories).toContain("hate");
    expect(result.severity).toBe("high");
    expect(result.reason).toBe("graphic violence");
  });

  it("passes correct tier and use case to orchestrator", async () => {
    mockOrchestratorResponse(
      '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}'
    );
    await classifyContent("test", "req-abc");

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [request, options] = mockComplete.mock.calls[0] as [
      AIRequest,
      OrchestratorOptions,
    ];
    expect(request.tier).toBe("fast");
    expect(options.useCase).toBe("safety-classify");
    expect(options.requestId).toBe("req-abc");
  });

  it("fails closed on non-text response", async () => {
    const response: AIResponse = {
      content: [{ type: "tool_use", id: "t1", name: "test", input: {} }],
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 100, outputTokens: 30 },
      stopReason: "end_turn",
    };
    mockComplete.mockResolvedValueOnce(response);

    const result = await classifyContent("test");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("unexpected response type");
  });

  it("fails closed on orchestrator error", async () => {
    mockComplete.mockRejectedValueOnce(new Error("Provider down"));
    const result = await classifyContent("test");
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("fails closed on malformed JSON response", async () => {
    mockOrchestratorResponse("not json");
    const result = await classifyContent("test");
    expect(result.safe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSafety — backwards-compatible wrapper
// ---------------------------------------------------------------------------

describe("checkSafety", () => {
  it("returns SafetyResult with safe:true", async () => {
    mockOrchestratorResponse(
      '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}'
    );
    const result = await checkSafety("clean text");
    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns SafetyResult with safe:false and reason", async () => {
    mockOrchestratorResponse(
      '{"safe": false, "categories": ["hate"], "confidence": 0.8, "severity": "high", "reason": "hate speech"}'
    );
    const result = await checkSafety("bad text");
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("hate speech");
  });

  it("fails closed on error — returns safe:false", async () => {
    mockComplete.mockRejectedValueOnce(new Error("timeout"));
    const result = await checkSafety("test");
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("accepts optional requestId", async () => {
    mockOrchestratorResponse(
      '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}'
    );
    await checkSafety("test", "custom-req-id");
    const [, options] = mockComplete.mock.calls[0] as [AIRequest, OrchestratorOptions];
    expect(options.requestId).toBe("custom-req-id");
  });

  it("generates requestId when not provided", async () => {
    mockOrchestratorResponse(
      '{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}'
    );
    await checkSafety("test");
    const [, options] = mockComplete.mock.calls[0] as [AIRequest, OrchestratorOptions];
    expect(options.requestId).toBeTruthy();
    expect(typeof options.requestId).toBe("string");
  });
});
