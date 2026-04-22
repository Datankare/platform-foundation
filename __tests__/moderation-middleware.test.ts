/**
 * __tests__/moderation-middleware.test.ts — screenContent middleware tests
 *
 * Tests: backward compatibility (no context), context passthrough,
 * direction handling, content type defaults.
 */

import { setOrchestrator, clearMetrics } from "@/platform/ai";
import type { AIResponse, Orchestrator, CircuitState } from "@/platform/ai";
import { screenContent } from "@/platform/moderation/middleware";
import { resetGuardian } from "@/platform/moderation/guardian";
import { resetModerationStore } from "@/platform/moderation/store";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "mock-req-id",
}));

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (key: string, defaultValue: unknown) => {
    const configMap: Record<string, unknown> = {
      "moderation.level1.block_severity": "medium",
      "moderation.level1.warn_severity": "low",
      "moderation.level1.escalate_below": 0.7,
      "moderation.level2.block_severity": "high",
      "moderation.level2.warn_severity": "medium",
      "moderation.level2.escalate_below": 0.6,
      "moderation.level3.block_severity": "critical",
      "moderation.level3.warn_severity": "high",
      "moderation.level3.escalate_below": 0.5,
      "moderation.translation_severity_reduction": 1,
      "moderation.transcription_severity_reduction": 1,
      "moderation.extraction_severity_reduction": 1,
    };
    return configMap[key] ?? defaultValue;
  }),
}));

const mockComplete = jest.fn();

function createMockOrchestrator(): Orchestrator {
  return {
    complete: mockComplete,
    getCircuitState: (): CircuitState => "closed",
    resetCircuit: jest.fn(),
    stream: jest.fn(),
  };
}

let previousOrchestrator: Orchestrator | null = null;

beforeAll(() => {
  previousOrchestrator = setOrchestrator(createMockOrchestrator());
});

afterAll(() => {
  if (previousOrchestrator) setOrchestrator(previousOrchestrator);
});

beforeEach(() => {
  mockComplete.mockReset();
  clearMetrics();
  resetGuardian();
  resetModerationStore();
});

function mockSafe(): void {
  mockComplete.mockResolvedValueOnce({
    content: [
      {
        type: "text",
        text: '{"safe": true, "categories": [], "confidence": 0.95, "severity": "low"}',
      },
    ],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 100, outputTokens: 30 },
    stopReason: "end_turn",
  } as AIResponse);
}

function mockUnsafe(severity: string, confidence: number): void {
  mockComplete.mockResolvedValueOnce({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          safe: false,
          categories: ["violence"],
          confidence,
          severity,
        }),
      },
    ],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 100, outputTokens: 30 },
    stopReason: "end_turn",
  } as AIResponse);
}

// ---------------------------------------------------------------------------
// Backward compatibility (no context)
// ---------------------------------------------------------------------------

describe("screenContent — backward compatible (no context)", () => {
  it("allows safe content", async () => {
    mockSafe();
    const result = await screenContent("hello", { direction: "input", requestId: "r1" });

    expect(result.action).toBe("allow");
    expect(result.contentType).toBe("generation");
    expect(result.contentRatingLevel).toBe(1);
  });

  it("blocks critical blocklist hits", async () => {
    const result = await screenContent("kill yourself", {
      direction: "input",
      requestId: "r2",
    });

    expect(result.action).toBe("block");
    expect(result.triggeredBy).toBe("blocklist");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("defaults to ai-output for output direction", async () => {
    mockSafe();
    const result = await screenContent("AI text", {
      direction: "output",
      requestId: "r3",
    });

    expect(result.contentType).toBe("ai-output");
  });
});

// ---------------------------------------------------------------------------
// With context
// ---------------------------------------------------------------------------

describe("screenContent — with context", () => {
  it("passes context to Guardian", async () => {
    mockSafe();
    const result = await screenContent("translation text", {
      direction: "input",
      requestId: "r4",
      context: {
        contentType: "translation",
        contentRatingLevel: 2,
        userId: "user-123",
        sourceLanguage: "ar",
        targetLanguage: "en",
      },
    });

    expect(result.contentType).toBe("translation");
    expect(result.contentRatingLevel).toBe(2);
  });

  it("applies severity reduction for translation", async () => {
    mockUnsafe("high", 0.9);
    const result = await screenContent("violent translation", {
      direction: "input",
      requestId: "r5",
      context: {
        contentType: "translation",
        contentRatingLevel: 2,
      },
    });

    // high - 1 = medium, Level 2 medium = warn
    expect(result.action).toBe("warn");
    expect(result.severityAdjustment).toBe(-1);
  });

  it("does not attribute to user for ai-output", async () => {
    mockUnsafe("high", 0.9);
    const result = await screenContent("bad AI output", {
      direction: "output",
      requestId: "r6",
      context: { contentType: "ai-output" },
    });

    expect(result.attributeToUser).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("screenContent — edge cases", () => {
  it("allows empty text", async () => {
    const result = await screenContent("", { direction: "input", requestId: "r7" });
    expect(result.action).toBe("allow");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("includes trajectory and agent IDs", async () => {
    mockSafe();
    const result = await screenContent("test", { direction: "input", requestId: "r8" });

    expect(result.trajectoryId).toMatch(/^traj-/);
    expect(result.agentId).toMatch(/^guardian-/);
  });

  it("includes reasoning", async () => {
    mockSafe();
    const result = await screenContent("hello", { direction: "input", requestId: "r9" });

    expect(result.reasoning.length).toBeGreaterThan(0);
  });
});
