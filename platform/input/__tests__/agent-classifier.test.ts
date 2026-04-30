/**
 * platform/input/__tests__/agent-classifier.test.ts
 *
 * Tests for the agent-backed audio classifier.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { AgentClassifier } from "../agent-classifier";
import type { InputEvent } from "../types";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";

function makeMockOrchestrator(responseText: string): Orchestrator {
  const response: AIResponse = {
    content: [{ type: "text", text: responseText }],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 50, outputTokens: 30 },
    stopReason: "end_turn",
  };
  return {
    complete: jest.fn().mockResolvedValue(response),
  } as unknown as Orchestrator;
}

function makeFailingOrchestrator(): Orchestrator {
  return {
    complete: jest.fn().mockRejectedValue(new Error("LLM unavailable")),
  } as unknown as Orchestrator;
}

function makeMicEvent(overrides: Partial<InputEvent> = {}): InputEvent {
  return {
    type: "mic",
    timestamp: new Date().toISOString(),
    requestId: "req-test",
    ...overrides,
  };
}

describe("AgentClassifier", () => {
  it("has correct name", () => {
    const orch = makeMockOrchestrator("{}");
    const classifier = new AgentClassifier(orch);
    expect(classifier.name).toBe("agent-classifier");
  });

  it("delegates non-mic events to rule-based fallback", async () => {
    const orch = makeMockOrchestrator("{}");
    const classifier = new AgentClassifier(orch);

    const result = await classifier.classify({
      type: "keystroke",
      text: "hello",
      timestamp: new Date().toISOString(),
    });

    expect(result.classifiedBy).toBe("rule-based");
    expect(result.classification).toBe("text");
    expect(orch.complete).not.toHaveBeenCalled();
  });

  it("classifies mic input as speech via LLM", async () => {
    const llmResponse = JSON.stringify({
      classification: "speech",
      confidence: 0.9,
      rhythmRegularity: 0.1,
      harmonicContent: 0.2,
      speechCadence: 0.8,
    });
    const orch = makeMockOrchestrator(llmResponse);
    const classifier = new AgentClassifier(orch);

    const result = await classifier.classify(makeMicEvent());

    expect(result.classification).toBe("speech");
    expect(result.confidence).toBe(0.9);
    expect(result.mode).toBe("speech");
    expect(result.classifiedBy).toBe("agent-classifier");
    expect(result.cost).toBeGreaterThan(0);
    expect(result.features).toBeDefined();
    expect(result.features?.speechCadence).toBe(0.8);
    expect(orch.complete).toHaveBeenCalledTimes(1);
  });

  it("classifies mic input as music via LLM", async () => {
    const llmResponse = JSON.stringify({
      classification: "music",
      confidence: 0.85,
      rhythmRegularity: 0.9,
      harmonicContent: 0.8,
      speechCadence: 0.1,
    });
    const orch = makeMockOrchestrator(llmResponse);
    const classifier = new AgentClassifier(orch);

    const result = await classifier.classify(makeMicEvent());

    expect(result.classification).toBe("music");
    expect(result.mode).toBe("music");
    expect(result.features?.rhythmRegularity).toBe(0.9);
  });

  it("falls back to rule-based on LLM error (P11)", async () => {
    const orch = makeFailingOrchestrator();
    const classifier = new AgentClassifier(orch);

    const result = await classifier.classify(makeMicEvent());

    expect(result.classifiedBy).toBe("rule-based");
    expect(result.classification).toBeDefined();
  });

  it("falls back to noise on malformed LLM response", async () => {
    const orch = makeMockOrchestrator("not json at all");
    const classifier = new AgentClassifier(orch);

    const result = await classifier.classify(makeMicEvent());

    expect(result.classification).toBe("noise");
    expect(result.classifiedBy).toBe("agent-classifier");
  });

  it("clamps confidence to 0-1 range", async () => {
    const llmResponse = JSON.stringify({
      classification: "speech",
      confidence: 1.5,
      rhythmRegularity: -0.1,
      harmonicContent: 2.0,
      speechCadence: 0.5,
    });
    const orch = makeMockOrchestrator(llmResponse);
    const classifier = new AgentClassifier(orch);

    const result = await classifier.classify(makeMicEvent());

    expect(result.confidence).toBe(1);
    expect(result.features?.rhythmRegularity).toBe(0);
    expect(result.features?.harmonicContent).toBe(1);
  });

  it("delegates paste events to rule-based fallback", async () => {
    const orch = makeMockOrchestrator("{}");
    const classifier = new AgentClassifier(orch);

    const result = await classifier.classify({
      type: "paste",
      text: "pasted text",
      timestamp: new Date().toISOString(),
    });

    expect(result.classifiedBy).toBe("rule-based");
    expect(orch.complete).not.toHaveBeenCalled();
  });

  it("delegates file events to rule-based fallback", async () => {
    const orch = makeMockOrchestrator("{}");
    const classifier = new AgentClassifier(orch);

    const result = await classifier.classify({
      type: "file",
      timestamp: new Date().toISOString(),
    });

    expect(result.classifiedBy).toBe("rule-based");
    expect(orch.complete).not.toHaveBeenCalled();
  });
});
