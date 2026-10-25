/**
 * platform/moderation/__tests__/outage-every-level.test.ts
 *
 * Review 7 H1: a classifier outage at content rating level 3 allowed the content. The fail-closed
 * placeholder (confidence 0.5, severity medium) went through level 3's seeded thresholds
 * (escalate below 0.5, warn at high, block at critical) and came out "allow"; the
 * screeningUnavailable flag was read only on the escalate branch.
 *
 * Now nothing that was not judged is cleared: an outage, or an answer that cannot be read, is
 * withheld at every rating level, for every direction and kind of content, whatever the
 * thresholds — and each surface that screens text through the Guardian refuses it.
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
import { screenContent } from "@/platform/moderation/middleware";
import { resetGuardian } from "@/platform/moderation/guardian";
import { resetModerationStore } from "@/platform/moderation/store";
import type { ContentRatingLevel, ScreeningDirection } from "@/platform/moderation/types";
import { checkOutputSafety, checkSafety, classifyContent } from "@/lib/safety";
import { defaultInputScreen, runInputScreen, screenPermits } from "@/platform/rag/screen";

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

const outage = () => mockComplete.mockRejectedValue(new Error("provider outage"));
const unreadable = () =>
  mockComplete.mockResolvedValue({
    content: [{ type: "text", text: "not json at all" }],
    model: "m",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  } as AIResponse);
const noTextBlock = () =>
  mockComplete.mockResolvedValue({
    content: [],
    model: "m",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  } as unknown as AIResponse);

describe("review 7 H1: a classifier outage is withheld at every level, direction and kind", () => {
  for (const level of LEVELS) {
    for (const direction of DIRECTIONS) {
      for (const contentType of KINDS) {
        it(`level ${level}, ${direction}, ${contentType}`, async () => {
          outage();
          const r = await screenContent("anything at all", {
            direction,
            requestId: `req-${level}-${direction}-${contentType}`,
            context: { userId: "user-r7", contentType, contentRatingLevel: level },
          });
          expect(r.screeningUnavailable).toBe(true);
          expect(r.action).toBe("escalate");
          // Nothing was judged: nobody reviews it, nobody is struck.
          expect(mockSubmitForReview).not.toHaveBeenCalled();
          expect(mockProcessBlock).not.toHaveBeenCalled();
        });
      }
    }
  }

  it("the reviewer's case: level 3 through the deprecated top-level option", async () => {
    outage();
    const r = await screenContent("anything at all", {
      direction: "input",
      requestId: "req-r7",
      contentRatingLevel: 3,
    });
    expect(r.screeningUnavailable).toBe(true);
    expect(r.action).toBe("escalate");
  });

  it.each(LEVELS)("a reply with no text block is withheld at level %s", async (level) => {
    noTextBlock();
    const r = await screenContent("x", {
      direction: "input",
      requestId: "req-nt",
      context: { contentType: "generation", contentRatingLevel: level },
    });
    expect(r.screeningUnavailable).toBe(true);
    expect(r.action).toBe("escalate");
  });

  it.each(LEVELS)(
    "an unreadable answer is withheld at level %s, and not queued (review 8 M4)",
    async (level) => {
      unreadable();
      const r = await screenContent("x", {
        direction: "input",
        requestId: "req-ur",
        context: { userId: "u", contentType: "generation", contentRatingLevel: level },
      });
      expect(r.action).toBe("escalate");
      expect(r.screeningUnavailable).toBe(true);
      expect(r.unjudgedReason).toBe("unreadable");
      expect(mockSubmitForReview).not.toHaveBeenCalled();
    }
  );

  it("a judged answer at level 3 is still governed by the level's thresholds", async () => {
    mockComplete.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            safe: false,
            categories: ["violence"],
            confidence: 0.9,
            severity: "medium",
          }),
        },
      ],
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    } as AIResponse);
    const r = await screenContent("cartoon violence", {
      direction: "input",
      requestId: "req-judged",
      context: { contentType: "generation", contentRatingLevel: 3 },
    });
    expect(r.action).toBe("allow");
  });
});

describe("review 7 H1: every surface refuses what was not judged", () => {
  it("AI input (lib/safety checkSafety / classifyContent)", async () => {
    outage();
    expect((await checkSafety("x", { requestId: "r1", userId: "u" })).safe).toBe(false);
    expect((await classifyContent("x", "r2")).safe).toBe(false);
  });

  it("AI output (lib/safety checkOutputSafety)", async () => {
    outage();
    expect((await checkOutputSafety("x", { requestId: "r3" })).safe).toBe(false);
  });

  it("retrieval input (platform/rag defaultInputScreen)", async () => {
    outage();
    const decision = await runInputScreen(defaultInputScreen, "x", "r4");
    expect(screenPermits(decision)).toBe(false);
  });
});
