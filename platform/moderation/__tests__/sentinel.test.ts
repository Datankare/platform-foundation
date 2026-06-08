/**
 * platform/moderation/__tests__/sentinel.test.ts
 *
 * Tests for the Sentinel account consequences agent.
 * Covers: processBlock flow, consequence evaluation (pure), status
 * transitions, strike failure surfacing (L19), trajectory recording.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks ───────────────────────────────────────────────────────────────

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn().mockResolvedValue(0),
}));

const mockSupabase = {
  from: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: { account_status: "active" },
      error: null,
    }),
    then: (resolve: any) => resolve({ data: null, error: null }),
  }),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(() => mockSupabase),
}));

jest.mock("../config", () => ({
  loadStrikeThresholds: jest.fn().mockResolvedValue({
    warnAt: 1,
    suspendAt: 3,
    banAt: 4,
  }),
}));

jest.mock("../review-service", () => ({
  submitForReview: jest.fn().mockResolvedValue({ success: true }),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import {
  Sentinel,
  evaluateConsequence,
  consequenceToStatus,
  getSentinel,
  resetSentinel,
} from "../sentinel";
import { InMemoryStrikeStore, setStrikeStore, resetStrikeStore } from "../strikes";
import { submitForReview } from "../review-service";
import type { ModerationResult } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeBlockResult(overrides: Partial<ModerationResult> = {}): ModerationResult {
  return {
    action: "block",
    triggeredBy: "classifier",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    classifierOutput: {
      safe: false,
      categories: ["harassment"],
      confidence: 0.95,
      severity: "medium",
    },
    reasoning: "Test block",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 50,
    classifierCostUsd: 0.001,
    trajectoryId: "guardian-traj-1",
    agentId: "guardian-1",
    ...overrides,
  };
}

// ── Setup ───────────────────────────────────────────────────────────────

let store: InMemoryStrikeStore;

beforeEach(() => {
  jest.clearAllMocks();
  store = new InMemoryStrikeStore();
  setStrikeStore(store);
});

afterEach(() => {
  resetStrikeStore();
});

// ═══════════════════════════════════════════════════════════════════════
// Pure functions
// ═══════════════════════════════════════════════════════════════════════

describe("evaluateConsequence (pure)", () => {
  const thresholds = { warnAt: 1, suspendAt: 3, banAt: 4 };

  it("returns none for zero strikes", () => {
    expect(evaluateConsequence(0, thresholds)).toBe("none");
  });

  it("returns warn at threshold", () => {
    expect(evaluateConsequence(1, thresholds)).toBe("warn");
  });

  it("returns warn below suspend", () => {
    expect(evaluateConsequence(2, thresholds)).toBe("warn");
  });

  it("returns suspend at threshold", () => {
    expect(evaluateConsequence(3, thresholds)).toBe("suspend");
  });

  it("returns ban at threshold", () => {
    expect(evaluateConsequence(4, thresholds)).toBe("ban");
  });

  it("returns ban above threshold", () => {
    expect(evaluateConsequence(10, thresholds)).toBe("ban");
  });
});

describe("consequenceToStatus (pure)", () => {
  it("ban → banned regardless of current status", () => {
    expect(consequenceToStatus("ban", "active")).toBe("banned");
    expect(consequenceToStatus("ban", "warned")).toBe("banned");
  });

  it("suspend → suspended", () => {
    expect(consequenceToStatus("suspend", "active")).toBe("suspended");
    expect(consequenceToStatus("suspend", "warned")).toBe("suspended");
  });

  it("warn → warned only if currently active", () => {
    expect(consequenceToStatus("warn", "active")).toBe("warned");
  });

  it("warn does not downgrade from a higher status", () => {
    expect(consequenceToStatus("warn", "suspended")).toBe("suspended");
    expect(consequenceToStatus("warn", "banned")).toBe("banned");
  });

  it("none preserves current status", () => {
    expect(consequenceToStatus("none", "active")).toBe("active");
    expect(consequenceToStatus("none", "warned")).toBe("warned");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Sentinel agent
// ═══════════════════════════════════════════════════════════════════════

describe("Sentinel", () => {
  it("has correct agent identity", () => {
    const sentinel = new Sentinel("test-sentinel");

    expect(sentinel.identity.actorType).toBe("agent");
    expect(sentinel.identity.actorId).toBe("test-sentinel");
    expect(sentinel.identity.agentRole).toBe("sentinel");
  });

  describe("processBlock — guard clauses (B5)", () => {
    it("throws on non-block action", async () => {
      const sentinel = new Sentinel("test");
      const result = makeBlockResult({ action: "allow" });
      await expect(sentinel.processBlock(result, "user-1", "req-1")).rejects.toThrow(
        "non-block action"
      );
    });

    it("throws when attributeToUser is false", async () => {
      const sentinel = new Sentinel("test");
      const result = makeBlockResult({ attributeToUser: false });
      await expect(sentinel.processBlock(result, "user-1", "req-1")).rejects.toThrow(
        "attributeToUser=false"
      );
    });

    it("throws when userId is empty", async () => {
      const sentinel = new Sentinel("test");
      const result = makeBlockResult();
      await expect(sentinel.processBlock(result, "", "req-1")).rejects.toThrow(
        "without userId"
      );
    });
  });

  describe("processBlock", () => {
    it("records a strike and returns result with trajectory", async () => {
      const sentinel = new Sentinel("test-sentinel");
      const result = await sentinel.processBlock(makeBlockResult(), "user-1", "req-1");

      expect(result.strike).toBeDefined();
      expect(result.strike.userId).toBe("user-1");
      expect(result.strike.category).toBe("harassment");
      expect(result.trajectoryId).toBeTruthy();
      expect(result.agentId).toBe("test-sentinel");
      expect(result.strikeSummary.totalActive).toBe(1);
    });

    it("produces 5 trajectory steps", async () => {
      const sentinel = new Sentinel();
      const result = await sentinel.processBlock(makeBlockResult(), "user-1", "req-1");

      // We can check reasoning contains expected content
      expect(result.reasoning).toContain("Guardian blocked");
      expect(result.reasoning).toContain("harassment");
      expect(result.reasoning).toContain("Strike recorded");
    });

    it("escalates to warn on first strike (threshold=1)", async () => {
      const sentinel = new Sentinel();
      const result = await sentinel.processBlock(makeBlockResult(), "user-1", "req-1");

      expect(result.consequenceAction).toBe("warn");
      expect(result.newStatus).toBe("warned");
    });

    it("escalates through consequence ladder", async () => {
      const sentinel = new Sentinel();

      // Strike 1 → warn
      const r1 = await sentinel.processBlock(makeBlockResult(), "user-1", "req-1");
      expect(r1.consequenceAction).toBe("warn");

      // Strike 2 → still warn
      const r2 = await sentinel.processBlock(makeBlockResult(), "user-1", "req-2");
      expect(r2.consequenceAction).toBe("warn");
      expect(r2.strikeSummary.totalActive).toBe(2);

      // Strike 3 → suspend
      const r3 = await sentinel.processBlock(makeBlockResult(), "user-1", "req-3");
      expect(r3.consequenceAction).toBe("suspend");

      // Strike 4 → ban
      const r4 = await sentinel.processBlock(makeBlockResult(), "user-1", "req-4");
      expect(r4.consequenceAction).toBe("ban");
    });

    it("uses unclassified category when no classifier output", async () => {
      const sentinel = new Sentinel();
      const result = await sentinel.processBlock(
        makeBlockResult({ classifierOutput: undefined }),
        "user-1",
        "req-1"
      );

      expect(result.strike.category).toBe("unclassified");
    });

    it("defaults to medium severity when no classifier output", async () => {
      const sentinel = new Sentinel();
      const result = await sentinel.processBlock(
        makeBlockResult({ classifierOutput: undefined }),
        "user-1",
        "req-1"
      );

      expect(result.strike.severity).toBe("medium");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Singleton
// ═══════════════════════════════════════════════════════════════════════

describe("singleton", () => {
  it("getSentinel returns instance", () => {
    resetSentinel();
    const sentinel = getSentinel();
    expect(sentinel.identity.agentRole).toBe("sentinel");
  });
});

describe("processBlock — ban_review submission (ADR-024)", () => {
  const submit = submitForReview as jest.Mock;

  beforeEach(() => {
    submit.mockReset();
    submit.mockResolvedValue({ success: true });
  });

  // banAt = 4 (mocked thresholds); status is mocked "active" on each load.
  async function driveToBan() {
    const sentinel = getSentinel();
    let result;
    for (let i = 0; i < 4; i++) {
      result = await sentinel.processBlock(makeBlockResult(), "user-1", "req-1");
    }
    return result!;
  }

  it("submits a ban_review with previousAccountStatus and strike link on ban", async () => {
    const result = await driveToBan();

    expect(result.newStatus).toBe("banned");
    expect(submit).toHaveBeenCalledTimes(1);
    const arg = submit.mock.calls[0][0];
    expect(arg.source).toBe("ban_review");
    expect(arg.targetUserId).toBe("user-1");
    expect(arg.previousAccountStatus).toBe("active");
    expect(typeof arg.relatedStrikeId).toBe("string");
  });

  it("does not submit a ban_review for a non-ban consequence", async () => {
    const sentinel = getSentinel();
    const result = await sentinel.processBlock(makeBlockResult(), "user-1", "req-1");

    expect(result.newStatus).toBe("warned");
    expect(submit).not.toHaveBeenCalled();
  });

  it("ban stands even if the ban_review submission throws (fail-open)", async () => {
    submit.mockRejectedValueOnce(new Error("review service down"));
    const result = await driveToBan();

    expect(result.newStatus).toBe("banned");
  });
});
