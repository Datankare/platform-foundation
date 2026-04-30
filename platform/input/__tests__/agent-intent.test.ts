/**
 * platform/input/__tests__/agent-intent.test.ts
 *
 * Tests for the agent-backed intent resolver.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { AgentIntentResolver } from "../agent-intent";
import type { ClassificationResult } from "../types";
import type { IntentContext } from "../intent";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";

function makeMockOrchestrator(responseText: string): Orchestrator {
  const response: AIResponse = {
    content: [{ type: "text", text: responseText }],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 60, outputTokens: 50 },
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

function makeClassification(
  overrides: Partial<ClassificationResult> = {}
): ClassificationResult {
  return {
    classification: "speech",
    confidence: 0.9,
    mode: "speech",
    classifiedBy: "agent-classifier",
    latencyMs: 50,
    cost: 0.001,
    ...overrides,
  };
}

function makeContext(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    currentMode: "speech",
    hasText: false,
    isRecording: false,
    ...overrides,
  };
}

describe("AgentIntentResolver", () => {
  it("has correct name", () => {
    const orch = makeMockOrchestrator("{}");
    const resolver = new AgentIntentResolver(orch);
    expect(resolver.name).toBe("agent-intent");
  });

  it("resolves intent via LLM", async () => {
    const llmResponse = JSON.stringify({
      intent: "translate-speech",
      displayLabel: "Translate spoken text",
      confidence: 0.85,
      actions: [
        { id: "translate", label: "Translate", primary: true },
        { id: "transcribe", label: "Transcribe only", primary: false },
      ],
    });
    const orch = makeMockOrchestrator(llmResponse);
    const resolver = new AgentIntentResolver(orch);

    const result = await resolver.resolve(makeClassification(), makeContext());

    expect(result.intent).toBe("translate-speech");
    expect(result.displayLabel).toBe("Translate spoken text");
    expect(result.confidence).toBe(0.85);
    expect(result.resolvedBy).toBe("agent-intent");
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0].id).toBe("translate");
    expect(result.actions[0].primary).toBe(true);
    expect(result.cost).toBeGreaterThan(0);
    expect(orch.complete).toHaveBeenCalledTimes(1);
  });

  it("falls back to rule-based on LLM error (P11)", async () => {
    const orch = makeFailingOrchestrator();
    const resolver = new AgentIntentResolver(orch);

    const result = await resolver.resolve(makeClassification(), makeContext());

    expect(result.resolvedBy).toBe("default");
    expect(result.intent).toBeDefined();
  });

  it("handles malformed LLM response gracefully", async () => {
    const orch = makeMockOrchestrator("not json");
    const resolver = new AgentIntentResolver(orch);

    const result = await resolver.resolve(makeClassification(), makeContext());

    expect(result.intent).toBe("unknown");
    expect(result.displayLabel).toBe("Processing...");
    expect(result.resolvedBy).toBe("agent-intent");
  });

  it("handles missing actions in response", async () => {
    const llmResponse = JSON.stringify({
      intent: "send-text",
      displayLabel: "Send message",
      confidence: 0.7,
    });
    const orch = makeMockOrchestrator(llmResponse);
    const resolver = new AgentIntentResolver(orch);

    const result = await resolver.resolve(
      makeClassification({ classification: "text", mode: "text" }),
      makeContext({ currentMode: "text", hasText: true })
    );

    expect(result.intent).toBe("send-text");
    expect(result.actions).toHaveLength(0);
  });

  it("caps actions at 4", async () => {
    const actions = Array.from({ length: 8 }, (_, i) => ({
      id: `action-${i}`,
      label: `Action ${i}`,
      primary: i === 0,
    }));
    const llmResponse = JSON.stringify({
      intent: "multi-action",
      displayLabel: "Many actions",
      confidence: 0.8,
      actions,
    });
    const orch = makeMockOrchestrator(llmResponse);
    const resolver = new AgentIntentResolver(orch);

    const result = await resolver.resolve(makeClassification(), makeContext());

    expect(result.actions).toHaveLength(4);
  });

  it("clamps confidence to 0-1 range", async () => {
    const llmResponse = JSON.stringify({
      intent: "test",
      displayLabel: "Test",
      confidence: 2.5,
      actions: [],
    });
    const orch = makeMockOrchestrator(llmResponse);
    const resolver = new AgentIntentResolver(orch);

    const result = await resolver.resolve(makeClassification(), makeContext());

    expect(result.confidence).toBe(1);
  });

  it("resolves for music classification", async () => {
    const llmResponse = JSON.stringify({
      intent: "identify-song",
      displayLabel: "Identify this song",
      confidence: 0.9,
      actions: [
        { id: "identify", label: "Identify Song", primary: true },
        { id: "save-clip", label: "Save Audio Clip", primary: false },
      ],
    });
    const orch = makeMockOrchestrator(llmResponse);
    const resolver = new AgentIntentResolver(orch);

    const result = await resolver.resolve(
      makeClassification({ classification: "music", mode: "music" }),
      makeContext({ currentMode: "music" })
    );

    expect(result.intent).toBe("identify-song");
    expect(result.actions).toHaveLength(2);
  });
});
