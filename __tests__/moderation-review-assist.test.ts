/**
 * __tests__/moderation-review-assist.test.ts
 *
 * Tests for the advisory reviewer-assist SERVICE. The orchestrator is mocked;
 * the real generateReviewRecommendation runs. Covers JSON parsing, fence
 * stripping, and fail-open behaviour (junk / invalid value / thrown error).
 *
 * The route is tested separately (moderation-review-assist-route.test.ts) —
 * mocking the service and running the real service cannot coexist in one file
 * because jest.mock is hoisted file-wide.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-req-id"),
}));

const mockComplete = jest.fn();
jest.mock("@/platform/ai", () => ({
  getOrchestrator: () => ({ complete: mockComplete }),
}));

import { generateReviewRecommendation } from "@/platform/moderation/review-assist";
import type { ReviewQueueItem } from "@/platform/moderation/review-types";

function makeItem(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    id: "review-1",
    source: "escalation",
    priority: "high",
    status: "claimed",
    moderationResult: {
      action: "escalate",
      triggeredBy: "classifier",
      direction: "input",
      contentType: "generation",
      contentRatingLevel: 1,
      blocklistMatches: [],
      classifierOutput: {
        safe: false,
        categories: ["violence"],
        confidence: 0.52,
        severity: "medium",
      },
      reasoning: "Low confidence — escalating.",
      severityAdjustment: 0,
      contextFactors: ["translation context"],
      attributeToUser: true,
      pipelineLatencyMs: 100,
      classifierCostUsd: 0.001,
      trajectoryId: "traj-1",
      agentId: "guardian-1",
    } as ReviewQueueItem["moderationResult"],
    targetUserId: "user-1",
    requestId: "req-1",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function textResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 10 },
    stopReason: "end_turn",
    model: "test",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("generateReviewRecommendation", () => {
  it("returns a parsed recommendation from valid JSON", async () => {
    mockComplete.mockResolvedValue(
      textResponse('{"recommendation":"overturn","rationale":"Historical context."}')
    );

    const rec = await generateReviewRecommendation(makeItem(), "req-1");

    expect(rec).toEqual({ recommendation: "overturn", rationale: "Historical context." });
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "standard" }),
      expect.objectContaining({ useCase: "review-assist" })
    );
  });

  it("strips markdown fences before parsing", async () => {
    mockComplete.mockResolvedValue(
      textResponse(
        '```json\n{"recommendation":"uphold","rationale":"Correct call."}\n```'
      )
    );

    const rec = await generateReviewRecommendation(makeItem(), "req-1");

    expect(rec?.recommendation).toBe("uphold");
  });

  it("returns null on unparseable output (fail-open)", async () => {
    mockComplete.mockResolvedValue(textResponse("I think you should overturn it."));

    const rec = await generateReviewRecommendation(makeItem(), "req-1");

    expect(rec).toBeNull();
  });

  it("returns null on an invalid recommendation value", async () => {
    mockComplete.mockResolvedValue(
      textResponse('{"recommendation":"delete","rationale":"nope"}')
    );

    const rec = await generateReviewRecommendation(makeItem(), "req-1");

    expect(rec).toBeNull();
  });

  it("returns null when the model call throws (fail-open)", async () => {
    mockComplete.mockRejectedValue(new Error("AI unavailable"));

    const rec = await generateReviewRecommendation(makeItem(), "req-1");

    expect(rec).toBeNull();
  });
});
