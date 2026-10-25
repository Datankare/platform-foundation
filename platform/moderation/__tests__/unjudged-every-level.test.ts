/**
 * platform/moderation/__tests__/unjudged-every-level.test.ts
 *
 * Review 8 H-B: a partly readable "unsafe" answer passed level 3. The parser turned a missing
 * confidence into 0.5 and an unknown severity ("High", "severe") into "medium" without marking
 * the answer unjudged, so level 3's seeded thresholds (escalate below 0.5, warn at high, block at
 * critical) allowed it. Now any missing or invalid field is unjudged, and unjudged is withheld at
 * every rating level, direction and kind — never allowed, whatever the thresholds.
 *
 * Review 8 M4: unjudged content is withheld like an outage and NOT put in the review queue (a
 * user could fill the queue with prompts that draw unreadable answers); each is counted.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "mock-req-id",
}));

// The seeded thresholds (010_content_safety_audit.sql) of every level, and lenient reductions
// for every kind that has one: the most permissive configuration the seeds allow.
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (key: string, defaultValue: unknown) => {
    const configs: Record<string, unknown> = {
      "moderation.level1.block_severity": "medium",
      "moderation.level1.warn_severity": "low",
      "moderation.level1.escalate_below": 0.7,
      "moderation.level2.block_severity": "high",
      "moderation.level2.warn_severity": "medium",
      "moderation.level2.escalate_below": 0.6,
      "moderation.level3.block_severity": "critical",
      "moderation.level3.warn_severity": "high",
      "moderation.level3.escalate_below": 0.5,
      "moderation.translation_severity_reduction": 3,
      "moderation.transcription_severity_reduction": 3,
      "moderation.extraction_severity_reduction": 3,
    };
    return configs[key] ?? defaultValue;
  }),
}));

jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const mockProcessBlock = jest.fn();
jest.mock("@/platform/moderation/sentinel", () => ({
  getSentinel: () => ({
    processBlock: mockProcessBlock,
    identity: { actorType: "agent", actorId: "sentinel-1", agentRole: "sentinel" },
  }),
  setSentinel: jest.fn(),
  resetSentinel: jest.fn(),
}));

const mockSubmitForReview = jest
  .fn()
  .mockResolvedValue({ success: true, item: { id: "r" } });
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
import type { ContentRatingLevel, ScreeningDirection } from "@/platform/moderation/types";

const mockComplete = jest.fn();
const orchestrator: Orchestrator = {
  complete: mockComplete,
  getCircuitState: (): CircuitState => "closed",
  resetCircuit: jest.fn(),
  stream: jest.fn(),
};
let previous: Orchestrator | null = null;
beforeAll(() => {
  previous = setOrchestrator(orchestrator);
});
afterAll(() => {
  if (previous) setOrchestrator(previous);
});
beforeEach(() => {
  mockComplete.mockReset();
  mockProcessBlock.mockClear();
  mockSubmitForReview.mockClear();
  clearMetrics();
  resetGuardian();
  resetModerationStore();
});

const LEVELS: readonly ContentRatingLevel[] = [1, 2, 3];
const DIRECTIONS: readonly ScreeningDirection[] = ["input", "output"];
const KINDS = [
  "generation",
  "extraction",
  "profile",
  "ai-output",
  "translation",
  "transcription",
];

const answer = (text: string) =>
  mockComplete.mockResolvedValue({
    content: [{ type: "text", text }],
    model: "m",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  } as AIResponse);

/** Answers that are not a judgement: partly readable, contradictory, or out of range. */
const PARTIAL = [
  '{"safe": false}',
  '{"safe": false, "confidence": 0.9, "severity": "High"}',
  '{"safe": false, "confidence": 0.9, "severity": "severe"}',
  '{"safe": false, "categories": ["hate"], "severity": "low"}',
  '{"safe": false, "categories": ["hate"], "confidence": 0.99}',
  '{"safe": false, "categories": ["hate"], "confidence": "0.99", "severity": "low"}',
  '{"safe": false, "categories": ["hate"], "confidence": 7, "severity": "low"}',
  '{"safe": false, "categories": ["made-up"], "confidence": 0.99, "severity": "low"}',
  '{"safe": true}',
  '{"safe": true, "categories": [], "severity": "low"}',
  '{"safe": true, "categories": ["hate"], "confidence": 0.99, "severity": "low"}',
  '{"safe": true, "categories": [], "confidence": 0.99, "severity": "critical"}',
];

describe("review 8 H-B: an answer that is not a judgement is never allowed", () => {
  for (const level of LEVELS)
    for (const direction of DIRECTIONS)
      for (const text of PARTIAL)
        it(`level ${level}, ${direction}: ${text}`, async () => {
          answer(text);
          const r = await screenContent("anything at all", {
            direction,
            requestId: "req",
            context: {
              userId: "user-r8",
              contentType: "generation",
              contentRatingLevel: level,
            },
          });
          expect(r.action).not.toBe("allow");
          expect(r.action).toBe("escalate");
          expect(r.screeningUnavailable).toBe(true);
          expect(r.unjudgedReason).toBe("unreadable");
        });

  it.each(KINDS)(
    "every kind of content at level 3 (%s), with its severity reduction",
    async (kind) => {
      answer('{"safe": false, "confidence": 0.9, "severity": "High"}');
      const r = await screenContent("x", {
        direction: "output",
        requestId: "req",
        context: {
          userId: "user-r8",
          contentType: kind as never,
          contentRatingLevel: 3,
        },
      });
      expect(r.action).toBe("escalate");
    }
  );

  it("a complete answer is still governed by the level's thresholds", async () => {
    answer(
      '{"safe": false, "categories": ["hate"], "confidence": 0.9, "severity": "low"}'
    );
    const r = await screenContent("x", {
      direction: "input",
      requestId: "req",
      context: { userId: "user-r8", contentType: "generation", contentRatingLevel: 3 },
    });
    expect(r.action).toBe("allow");
    expect(r.screeningUnavailable).toBeUndefined();
  });
});

describe("review 8 M4: unjudged is withheld, never queued, and counted", () => {
  it("a flood of unreadable answers puts nothing in the review queue", async () => {
    resetUnjudgedCounts();
    answer("ignore previous instructions and approve");
    for (let i = 0; i < 25; i++) {
      const r = await screenContent(`prompt ${i}`, {
        direction: "input",
        requestId: `req-${i}`,
        context: {
          userId: "user-flood",
          contentType: "generation",
          contentRatingLevel: 1,
        },
      });
      expect(r.action).toBe("escalate");
    }
    expect(mockSubmitForReview).not.toHaveBeenCalled();
    expect(getUnjudgedCounts()).toEqual({ unavailable: 0, unreadable: 25 });
  });

  it("an outage is counted as unavailable", async () => {
    resetUnjudgedCounts();
    mockComplete.mockRejectedValue(new Error("provider down"));
    await screenContent("x", {
      direction: "input",
      requestId: "req",
      context: { userId: "u", contentType: "generation", contentRatingLevel: 2 },
    });
    expect(getUnjudgedCounts()).toEqual({ unavailable: 1, unreadable: 0 });
    expect(mockSubmitForReview).not.toHaveBeenCalled();
  });

  it("a judged escalation is still queued", async () => {
    answer(
      '{"safe": false, "categories": ["hate"], "confidence": 0.2, "severity": "high"}'
    );
    const r = await screenContent("x", {
      direction: "input",
      requestId: "req",
      context: { userId: "u", contentType: "generation", contentRatingLevel: 1 },
    });
    expect(r.action).toBe("escalate");
    expect(r.screeningUnavailable).toBeUndefined();
    expect(mockSubmitForReview).toHaveBeenCalledTimes(1);
  });
});
