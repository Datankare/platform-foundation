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

const mockSupabase = {
  from: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: { account_status: "active" },
      error: null,
    }),
    update: jest.fn().mockReturnThis(),
  }),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: () => mockSupabase,
}));

import { setOrchestrator, clearMetrics } from "@/platform/ai";
import type { AIResponse, Orchestrator, CircuitState } from "@/platform/ai";
import { screenContent } from "@/platform/moderation/middleware";
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
