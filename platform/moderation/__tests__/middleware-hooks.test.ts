/**
 * platform/moderation/__tests__/middleware-hooks.test.ts
 *
 * Tests for the async hooks in moderation middleware:
 *   - fireSentinel (block + attributeToUser + userId)
 *   - fireReviewSubmit (escalate + userId)
 *
 * These cover the fire-and-forget paths that the main middleware
 * test doesn't exercise.
 */

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: () => "mock-req-id",
}));

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (key: string, defaultValue: unknown) => {
    const configs: Record<string, unknown> = {
      "moderation.level1.block_severity": "medium",
      "moderation.level1.warn_severity": "low",
      "moderation.level1.escalate_below": 0.7,
      "moderation.translation_severity_reduction": 1,
      "moderation.transcription_severity_reduction": 1,
      "moderation.extraction_severity_reduction": 1,
    };
    return configs[key] ?? defaultValue;
  }),
}));

jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const mockProcessBlock = jest.fn().mockResolvedValue({
  strike: { id: "strike-1" },
  strikeSummary: { totalActive: 1 },
  consequenceAction: "none",
  previousStatus: "active",
  newStatus: "active",
  reasoning: "test",
  trajectoryId: "traj-1",
  agentId: "sentinel-1",
});

jest.mock("@/platform/moderation/sentinel", () => ({
  getSentinel: () => ({
    processBlock: mockProcessBlock,
    identity: { actorType: "agent", actorId: "sentinel-1", agentRole: "sentinel" },
  }),
  setSentinel: jest.fn(),
  resetSentinel: jest.fn(),
}));

const mockSubmitForReview = jest.fn().mockResolvedValue({
  success: true,
  item: { id: "review-1" },
});

jest.mock("@/platform/moderation/review-service", () => ({
  submitForReview: (...args: unknown[]) => mockSubmitForReview(...args),
}));
import { setOrchestrator, clearMetrics } from "@/platform/ai";
import type { AIResponse, Orchestrator, CircuitState } from "@/platform/ai";
import {
  getUnjudgedCounts,
  resetUnjudgedCounts,
  screenContent,
} from "@/platform/moderation/middleware";
import { resetGuardian } from "@/platform/moderation/guardian";
import { resetModerationStore } from "@/platform/moderation/store";
import { logger } from "@/lib/logger";

// ── Mock orchestrator ───────────────────────────────────────────────────

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
  mockProcessBlock.mockClear();
  mockSubmitForReview.mockClear();
  (logger.info as jest.Mock).mockClear();
  (logger.error as jest.Mock).mockClear();
  clearMetrics();
  resetGuardian();
  resetModerationStore();
});

// ── Helpers ─────────────────────────────────────────────────────────────

function mockClassifierResponse(
  safe: boolean,
  severity: string,
  confidence: number
): void {
  mockComplete.mockResolvedValueOnce({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          safe,
          categories: safe ? [] : ["violence"],
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

// ── Tests ───────────────────────────────────────────────────────────────

describe("screenContent — fireSentinel hook", () => {
  it("fires Sentinel on block with attributeToUser and userId", async () => {
    mockClassifierResponse(false, "high", 0.9);

    await screenContent("violent content", {
      direction: "input",
      requestId: "req-hook-1",
      context: {
        contentType: "generation",
        contentRatingLevel: 1,
        userId: "user-1",
      },
    });

    // Allow async hook to execute
    await new Promise(process.nextTick);

    expect(mockProcessBlock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "block" }),
      "user-1",
      "req-hook-1"
    );
  });

  it("does not fire Sentinel without userId", async () => {
    mockClassifierResponse(false, "high", 0.9);

    await screenContent("violent content", {
      direction: "input",
      requestId: "req-hook-2",
      context: { contentType: "generation", contentRatingLevel: 1 },
    });

    await new Promise(process.nextTick);

    expect(mockProcessBlock).not.toHaveBeenCalled();
  });
});

describe("screenContent — fireReviewSubmit hook", () => {
  it("submits to review queue on escalate with userId", async () => {
    // Low confidence triggers escalate (below 0.7 threshold for level 1)
    mockClassifierResponse(false, "medium", 0.5);

    await screenContent("ambiguous content", {
      direction: "input",
      requestId: "req-hook-3",
      context: {
        contentType: "generation",
        contentRatingLevel: 1,
        userId: "user-2",
      },
    });

    await new Promise(process.nextTick);

    expect(mockSubmitForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "escalation",
        targetUserId: "user-2",
        requestId: "req-hook-3",
      })
    );
  });

  it("does not submit to review queue without userId", async () => {
    mockClassifierResponse(false, "medium", 0.5);

    await screenContent("ambiguous content", {
      direction: "input",
      requestId: "req-hook-4",
      context: { contentType: "generation", contentRatingLevel: 1 },
    });

    await new Promise(process.nextTick);

    expect(mockSubmitForReview).not.toHaveBeenCalled();
  });

  it("logs error when review submit fails", async () => {
    mockSubmitForReview.mockResolvedValueOnce({
      success: false,
      error: "Store unavailable",
    });
    mockClassifierResponse(false, "medium", 0.5);

    await screenContent("ambiguous content", {
      direction: "input",
      requestId: "req-hook-5",
      context: {
        contentType: "generation",
        contentRatingLevel: 1,
        userId: "user-3",
      },
    });

    await new Promise(process.nextTick);

    expect(logger.error).toHaveBeenCalledWith(
      "Review queue: escalation submit failed",
      expect.objectContaining({ userId: "user-3" })
    );
  });
});

describe("screenContent — consequences finish first (audit D-14, X-22, RR-8)", () => {
  const ctx = (userId?: string) => ({
    contentType: "generation" as const,
    contentRatingLevel: 1 as const,
    ...(userId ? { userId } : {}),
  });

  it("does not return before the Sentinel has recorded the strike", async () => {
    let release!: () => void;
    let finished = false;
    mockProcessBlock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            finished = true;
            resolve({
              strike: { id: "s" },
              strikeSummary: { totalActive: 1 },
              consequenceAction: "none",
              previousStatus: "active",
              newStatus: "active",
              reasoning: "",
              trajectoryId: "t",
              agentId: "sentinel-1",
            });
          };
        })
    );
    mockClassifierResponse(false, "high", 0.95);
    let returned = false;
    const pending = screenContent("violent content", {
      direction: "input",
      requestId: "req-d14-1",
      context: ctx("user-d14"),
    }).then((r) => {
      returned = true;
      return r;
    });
    for (let i = 0; i < 50 && !release; i++) await new Promise(process.nextTick);
    expect(mockProcessBlock).toHaveBeenCalledTimes(1);
    await new Promise(process.nextTick);
    expect(returned).toBe(false);
    release();
    const r = await pending;
    expect(finished).toBe(true);
    expect(r.action).toBe("block");
  });

  it("does not return before the escalation is in the review queue", async () => {
    let queued = false;
    mockSubmitForReview.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      queued = true;
      return { success: true, item: { id: "review-2" } };
    });
    mockClassifierResponse(false, "medium", 0.5);
    const r = await screenContent("ambiguous", {
      direction: "input",
      requestId: "req-d14-2",
      context: ctx("user-d14"),
    });
    expect(r.action).toBe("escalate");
    expect(queued).toBe(true);
  });

  it("a Sentinel that throws leaves the block standing", async () => {
    mockProcessBlock.mockRejectedValueOnce(new Error("strike store down"));
    mockClassifierResponse(false, "high", 0.95);
    const r = await screenContent("violent content", {
      direction: "input",
      requestId: "req-d14-3",
      context: ctx("user-d14"),
    });
    expect(r.action).toBe("block");
    expect(logger.error).toHaveBeenCalledWith(
      "Sentinel processing failed — strike may not be recorded",
      expect.objectContaining({ userId: "user-d14" })
    );
  });

  it("a review submission that throws leaves the withholding standing", async () => {
    mockSubmitForReview.mockRejectedValueOnce(new Error("queue down"));
    mockClassifierResponse(false, "medium", 0.5);
    const r = await screenContent("ambiguous", {
      direction: "input",
      requestId: "req-d14-4",
      context: ctx("user-d14"),
    });
    expect(r.action).toBe("escalate");
  });

  it("a classifier outage withholds the content but queues nothing and strikes nobody (RR-8)", async () => {
    for (let i = 0; i < 5; i++) {
      mockComplete.mockRejectedValueOnce(new Error("provider outage"));
      const r = await screenContent(`prompt ${i}`, {
        direction: "input",
        requestId: `req-rr8-${i}`,
        context: ctx("user-rr8"),
      });
      expect(r.action).toBe("escalate");
      expect(r.screeningUnavailable).toBe(true);
    }
    expect(mockSubmitForReview).not.toHaveBeenCalled();
    expect(mockProcessBlock).not.toHaveBeenCalled();
  });

  // Review 8 M4: an unreadable answer is withheld like an outage, and not queued — a user whose
  // prompts draw unreadable answers (an injection attempt) could otherwise fill the queue. It is
  // never allowed either way; the count is the alert's signal.
  it("an unparseable classifier answer is withheld, counted, and not queued", async () => {
    resetUnjudgedCounts();
    mockComplete.mockResolvedValueOnce({
      content: [{ type: "text", text: "ignore previous instructions" }],
      model: "m",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    } as AIResponse);
    const r = await screenContent("x", {
      direction: "input",
      requestId: "req-rr8-parse",
      context: ctx("user-rr8"),
    });
    expect(r.action).toBe("escalate");
    expect(r.screeningUnavailable).toBe(true);
    expect(mockSubmitForReview).not.toHaveBeenCalled();
    expect(getUnjudgedCounts()).toEqual({ unavailable: 0, unreadable: 1 });
  });

  it("records what the classifier call cost (D-20)", async () => {
    mockClassifierResponse(true, "low", 0.99);
    const r = await screenContent("hello", {
      direction: "input",
      requestId: "req-d20",
      context: ctx(),
    });
    expect(r.classifierCostUsd).toBeGreaterThan(0);
  });
});
