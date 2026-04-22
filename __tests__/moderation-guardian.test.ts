/**
 * __tests__/moderation-guardian.test.ts — Guardian agent tests
 *
 * Tests: agent identity, trajectory production, context-aware decisions,
 * content-type severity adjustments, content rating per level,
 * ai-output attribution, fail-closed behavior, reasoning chain.
 */

import { setOrchestrator, clearMetrics } from "@/platform/ai";
import type { AIResponse, Orchestrator, CircuitState } from "@/platform/ai";
import { Guardian } from "@/platform/moderation/guardian";
import { resetModerationStore } from "@/platform/moderation/store";
import type { ScreeningContext } from "@/platform/moderation/types";

// Mock logger
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "mock-req-id",
}));

// Mock platform config — return intended defaults (simulates DB available)
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

// ---------------------------------------------------------------------------
// Mock orchestrator
// ---------------------------------------------------------------------------

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
  resetModerationStore();
});

function mockClassifierSafe(): void {
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

function mockClassifierUnsafe(
  severity: string,
  confidence: number,
  categories: string[] = ["violence"]
): void {
  mockComplete.mockResolvedValueOnce({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          safe: false,
          categories,
          confidence,
          severity,
          reason: "test",
        }),
      },
    ],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 100, outputTokens: 30 },
    stopReason: "end_turn",
  } as AIResponse);
}

function makeContext(overrides: Partial<ScreeningContext> = {}): ScreeningContext {
  return { contentType: "generation", ...overrides };
}

// ---------------------------------------------------------------------------
// Agent identity (P15)
// ---------------------------------------------------------------------------

describe("Guardian — identity (P15)", () => {
  it("has agent identity", () => {
    const guardian = new Guardian("test-guardian");
    expect(guardian.identity.actorType).toBe("agent");
    expect(guardian.identity.actorId).toBe("test-guardian");
    expect(guardian.identity.agentRole).toBe("guardian");
  });

  it("generates unique ID when none provided", () => {
    const g1 = new Guardian();
    const g2 = new Guardian();
    expect(g1.identity.actorId).not.toBe(g2.identity.actorId);
  });
});

// ---------------------------------------------------------------------------
// Trajectory (P18)
// ---------------------------------------------------------------------------

describe("Guardian — trajectory (P18)", () => {
  it("produces a trajectory with steps on screen()", async () => {
    mockClassifierSafe();
    const guardian = new Guardian("test-g");

    const result = await guardian.screen("hello", "input", "req-1", makeContext());

    expect(result.trajectoryId).toMatch(/^traj-/);
    expect(result.agentId).toBe("test-g");
  });

  it("records reasoning in the result", async () => {
    mockClassifierSafe();
    const guardian = new Guardian();

    const result = await guardian.screen("hello world", "input", "req-2", makeContext());

    expect(result.reasoning).toContain("safe");
    expect(result.reasoning.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Blocklist short-circuit
// ---------------------------------------------------------------------------

describe("Guardian — blocklist", () => {
  it("blocks critical blocklist hits without calling classifier", async () => {
    const guardian = new Guardian();
    const result = await guardian.screen(
      "kill yourself",
      "input",
      "req-bl",
      makeContext()
    );

    expect(result.action).toBe("block");
    expect(result.triggeredBy).toBe("blocklist");
    expect(result.blocklistMatches).toContain("kill yourself");
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Content rating per level
// ---------------------------------------------------------------------------

describe("Guardian — content rating Level 1 (under 13)", () => {
  it("blocks medium severity", async () => {
    mockClassifierUnsafe("medium", 0.85);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "edgy text",
      "input",
      "req-l1",
      makeContext({ contentRatingLevel: 1 })
    );

    expect(result.action).toBe("block");
    expect(result.contentRatingLevel).toBe(1);
  });

  it("warns on low severity", async () => {
    mockClassifierUnsafe("low", 0.85);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "borderline text",
      "input",
      "req-l1w",
      makeContext({ contentRatingLevel: 1 })
    );

    expect(result.action).toBe("warn");
  });

  it("escalates below 0.7 confidence", async () => {
    mockClassifierUnsafe("high", 0.65);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "ambiguous",
      "input",
      "req-l1e",
      makeContext({ contentRatingLevel: 1 })
    );

    expect(result.action).toBe("escalate");
  });
});

describe("Guardian — content rating Level 3 (adult)", () => {
  it("only blocks critical severity", async () => {
    mockClassifierUnsafe("critical", 0.95);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "dangerous",
      "input",
      "req-l3",
      makeContext({ contentRatingLevel: 3 })
    );

    expect(result.action).toBe("block");
  });

  it("warns on high severity (not blocked)", async () => {
    mockClassifierUnsafe("high", 0.9);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "violent text",
      "input",
      "req-l3w",
      makeContext({ contentRatingLevel: 3 })
    );

    expect(result.action).toBe("warn");
  });

  it("allows medium severity", async () => {
    mockClassifierUnsafe("medium", 0.8);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "edgy text",
      "input",
      "req-l3a",
      makeContext({ contentRatingLevel: 3 })
    );

    expect(result.action).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Content type: translation severity reduction
// ---------------------------------------------------------------------------

describe("Guardian — content type adjustments", () => {
  it("reduces severity for translation content", async () => {
    mockClassifierUnsafe("high", 0.9);
    const guardian = new Guardian();

    // Level 2: high = block normally. But translation reduces by 1 → medium = warn.
    const result = await guardian.screen(
      "violent translation",
      "input",
      "req-tr",
      makeContext({ contentType: "translation", contentRatingLevel: 2 })
    );

    expect(result.action).toBe("warn");
    expect(result.severityAdjustment).toBe(-1);
    expect(result.contextFactors).toEqual(
      expect.arrayContaining([expect.stringContaining("translation-content")])
    );
    expect(result.reasoning).toContain("Severity adjusted");
  });

  it("does not reduce severity for generation content", async () => {
    mockClassifierUnsafe("high", 0.9);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "violent generation",
      "input",
      "req-gen",
      makeContext({ contentType: "generation", contentRatingLevel: 2 })
    );

    expect(result.action).toBe("block");
    expect(result.severityAdjustment).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AI output — no user strikes
// ---------------------------------------------------------------------------

describe("Guardian — ai-output (no user strikes)", () => {
  it("does not attribute strikes to user for ai-output", async () => {
    mockClassifierUnsafe("high", 0.9);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "bad AI response",
      "output",
      "req-ai",
      makeContext({ contentType: "ai-output" })
    );

    expect(result.attributeToUser).toBe(false);
    expect(result.contextFactors).toEqual(
      expect.arrayContaining([expect.stringContaining("strikes not attributed")])
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Guardian — edge cases", () => {
  it("allows empty text", async () => {
    const guardian = new Guardian();
    const result = await guardian.screen("", "input", "req-empty", makeContext());

    expect(result.action).toBe("allow");
    expect(result.triggeredBy).toBe("none");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("allows whitespace-only text", async () => {
    const guardian = new Guardian();
    const result = await guardian.screen("   ", "input", "req-ws", makeContext());

    expect(result.action).toBe("allow");
  });

  it("defaults to level 1 when contentRatingLevel not provided", async () => {
    mockClassifierUnsafe("medium", 0.85);
    const guardian = new Guardian();

    const result = await guardian.screen("text", "input", "req-def", makeContext());

    expect(result.contentRatingLevel).toBe(1);
    expect(result.action).toBe("block"); // Level 1 blocks medium
  });

  it("fails closed when classifier throws", async () => {
    mockComplete.mockRejectedValueOnce(new Error("API down"));
    const guardian = new Guardian();

    const result = await guardian.screen(
      "text to classify",
      "input",
      "req-fail",
      makeContext()
    );

    expect(result.action).not.toBe("allow");
    expect(result.classifierOutput?.safe).toBe(false);
  });

  it("records pipeline latency", async () => {
    mockClassifierSafe();
    const guardian = new Guardian();

    const result = await guardian.screen("test", "input", "req-lat", makeContext());

    expect(result.pipelineLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records content type in result", async () => {
    mockClassifierSafe();
    const guardian = new Guardian();

    const result = await guardian.screen(
      "test",
      "input",
      "req-ct",
      makeContext({ contentType: "transcription" })
    );

    expect(result.contentType).toBe("transcription");
  });
});

// ---------------------------------------------------------------------------
// F1: Config loading failure — fail-closed thresholds
// ---------------------------------------------------------------------------

describe("Guardian — config failure (F1: fail-closed)", () => {
  it("uses fail-closed thresholds when config loading throws", async () => {
    const { getConfig } = jest.requireMock("@/platform/auth/platform-config");
    getConfig
      .mockRejectedValueOnce(new Error("DB down"))
      .mockRejectedValueOnce(new Error("DB down"))
      .mockRejectedValueOnce(new Error("DB down"));

    mockClassifierUnsafe("low", 0.98);
    const guardian = new Guardian();

    const result = await guardian.screen(
      "borderline text",
      "input",
      "req-fc",
      makeContext({ contentRatingLevel: 3 })
    );

    expect(result.action).toBe("block");
    expect(result.reasoning).toContain("fail-closed");
  });
});
