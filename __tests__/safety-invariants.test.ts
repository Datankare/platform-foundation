/**
 * Architectural invariant tests — safety.ts
 *
 * Control 5: Every error handling path gets a test, including
 * paths that seem unlikely. These tests enforce ADR-005's
 * fail-closed requirement at the code level.
 *
 * Phase 2: Mocks the orchestrator (ADR-015), not the SDK directly.
 */

import { setOrchestrator, clearMetrics } from "@/platform/ai";
import type { AIResponse, Orchestrator, CircuitState } from "@/platform/ai";

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

import { checkSafety } from "@/lib/safety";

describe("safety.ts — fail-closed invariants", () => {
  afterEach(() => {
    mockComplete.mockReset();
    clearMetrics();
  });

  it("returns unsafe when orchestrator returns a non-text content block", async () => {
    mockComplete.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 50, outputTokens: 20 },
      stopReason: "end_turn",
    } satisfies AIResponse);
    const result = await checkSafety("test input");
    expect(result.safe).toBe(false);
  });

  it("returns unsafe when orchestrator returns empty content array", async () => {
    mockComplete.mockResolvedValueOnce({
      content: [],
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 50, outputTokens: 0 },
      stopReason: "end_turn",
    } satisfies AIResponse);
    const result = await checkSafety("test input");
    expect(result.safe).toBe(false);
  });

  it("returns unsafe when JSON parse fails", async () => {
    mockComplete.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json at all" }],
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 50, outputTokens: 20 },
      stopReason: "end_turn",
    } satisfies AIResponse);
    const result = await checkSafety("test input");
    expect(result.safe).toBe(false);
  });

  it("returns safe only when classifier explicitly says safe:true", async () => {
    mockComplete.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"safe": true, "categories": [], "confidence": 0.95, "severity": "low"}',
        },
      ],
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 50, outputTokens: 30 },
      stopReason: "end_turn",
    } satisfies AIResponse);
    const result = await checkSafety("hello world");
    expect(result.safe).toBe(true);
  });

  it("returns unsafe with reason when classifier says safe:false", async () => {
    mockComplete.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"safe": false, "categories": ["violence"], "confidence": 0.9, "severity": "high", "reason": "violent content"}',
        },
      ],
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 50, outputTokens: 30 },
      stopReason: "end_turn",
    } satisfies AIResponse);
    const result = await checkSafety("violent text");
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("violent content");
  });

  it("fails closed when orchestrator throws", async () => {
    mockComplete.mockRejectedValueOnce(new Error("circuit breaker open"));
    const result = await checkSafety("test input");
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
