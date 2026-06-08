/**
 * platform/moderation/__tests__/review-service.test.ts
 *
 * Tests for the human review business logic.
 * Covers: submitForReview, submitAppeal (validation), claim/unclaim,
 * resolve (uphold/overturn/modify), expired claim release, side effects.
 *
 * Split into multiple top-level describes to stay within
 * max-lines-per-function (300).
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
  getConfig: jest.fn().mockImplementation((key: string, defaultVal: unknown) => {
    const configs: Record<string, unknown> = {
      "moderation.appeal_window_hours": 72,
      "moderation.review_claim_timeout_hours": 24,
      "moderation.appeal_reason_min_length": 20,
    };
    return Promise.resolve(configs[key] ?? defaultVal);
  }),
}));

const mockSupabase = {
  from: jest.fn().mockReturnValue({
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    then: (resolve: any) => resolve({ error: null }),
  }),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(() => mockSupabase),
}));

import {
  submitForReview,
  submitAppeal,
  claimItem,
  unclaimItem,
  resolveItem,
  releaseExpiredClaims,
  getQueue,
  getQueueStats,
} from "../review-service";
import { InMemoryReviewQueueStore, setReviewQueueStore } from "../review-store";
import { InMemoryStrikeStore, setStrikeStore } from "../strikes";
import type { ModerationResult } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeModerationResult(
  overrides: Partial<ModerationResult> = {}
): ModerationResult {
  return {
    action: "escalate",
    triggeredBy: "content-rating",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    reasoning: "Low confidence — escalating.",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 250,
    classifierCostUsd: 0.001,
    trajectoryId: "traj-test-1",
    agentId: "guardian-test-1",
    ...overrides,
  };
}

// ── Shared setup ────────────────────────────────────────────────────────

let reviewStore: InMemoryReviewQueueStore;

beforeEach(() => {
  reviewStore = new InMemoryReviewQueueStore();
  setReviewQueueStore(reviewStore);
  const strikeStore = new InMemoryStrikeStore();
  setStrikeStore(strikeStore);
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// submitForReview
// ═══════════════════════════════════════════════════════════════════════

describe("submitForReview", () => {
  it("submits an escalation with high priority", async () => {
    const result = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });

    expect(result.success).toBe(true);
    expect(result.item!.source).toBe("escalation");
    expect(result.item!.priority).toBe("high");
    expect(result.item!.status).toBe("pending");
  });

  it("submits a ban review with critical priority", async () => {
    const result = await submitForReview({
      source: "ban_review",
      moderationResult: makeModerationResult({ action: "block" }),
      targetUserId: "user-1",
      requestId: "req-1",
    });

    expect(result.success).toBe(true);
    expect(result.item!.priority).toBe("critical");
  });

  it("preserves explanation chain", async () => {
    const chain = {
      id: "expl-1",
      requestId: "req-1",
      steps: [
        {
          phase: "retrieval",
          description: "Retrieved 3 chunks",
          data: {},
          durationMs: 42,
        },
      ],
      conclusion: "Context applied",
      createdAt: new Date().toISOString(),
    };

    const result = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
      explanationChain: chain,
    });

    expect(result.item!.explanationChain).toBeDefined();
    expect(result.item!.explanationChain!.id).toBe("expl-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// submitAppeal
// ═══════════════════════════════════════════════════════════════════════

describe("submitAppeal", () => {
  const validTimestamp = new Date().toISOString();

  it("submits a valid appeal", async () => {
    const result = await submitAppeal(
      {
        originalDecisionId: "traj-orig-1",
        moderationResult: makeModerationResult({ action: "block" }),
        appealingUserId: "user-1",
        appealReason: "I was translating a historical document about conflict.",
        requestId: "req-1",
      },
      validTimestamp
    );

    expect(result.success).toBe(true);
    expect(result.item!.source).toBe("appeal");
    expect(result.item!.priority).toBe("normal");
    expect(result.item!.appealReason).toContain("historical document");
    expect(result.item!.originalDecisionId).toBe("traj-orig-1");
  });

  it("rejects appeal for non-block action", async () => {
    const result = await submitAppeal(
      {
        originalDecisionId: "traj-orig-1",
        moderationResult: makeModerationResult({ action: "allow" }),
        appealingUserId: "user-1",
        appealReason: "This should not be allowed to be appealed.",
        requestId: "req-1",
      },
      validTimestamp
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Only blocked");
  });

  it("rejects appeal with short reason", async () => {
    const result = await submitAppeal(
      {
        originalDecisionId: "traj-orig-1",
        moderationResult: makeModerationResult({ action: "block" }),
        appealingUserId: "user-1",
        appealReason: "unfair",
        requestId: "req-1",
      },
      validTimestamp
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("at least 20 characters");
  });

  it("rejects appeal outside window", async () => {
    const oldTimestamp = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();

    const result = await submitAppeal(
      {
        originalDecisionId: "traj-orig-1",
        moderationResult: makeModerationResult({ action: "block" }),
        appealingUserId: "user-1",
        appealReason: "I was translating a historical document about conflict.",
        requestId: "req-1",
      },
      oldTimestamp
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("window has expired");
  });

  it("rejects duplicate appeal for same decision", async () => {
    await submitAppeal(
      {
        originalDecisionId: "traj-orig-dup",
        moderationResult: makeModerationResult({ action: "block" }),
        appealingUserId: "user-1",
        appealReason: "First appeal for this decision with enough text.",
        requestId: "req-1",
      },
      validTimestamp
    );

    const result = await submitAppeal(
      {
        originalDecisionId: "traj-orig-dup",
        moderationResult: makeModerationResult({ action: "block" }),
        appealingUserId: "user-1",
        appealReason: "Second appeal for the same decision should fail.",
        requestId: "req-2",
      },
      validTimestamp
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("already pending");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// claimItem + unclaimItem
// ═══════════════════════════════════════════════════════════════════════

describe("claimItem", () => {
  it("claims a pending item", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });

    const result = await claimItem(submitted.item!.id, "admin-1");

    expect(result.success).toBe(true);
    expect(result.item!.status).toBe("claimed");
    expect(result.item!.claimedBy).toBe("admin-1");
    expect(result.item!.claimedAt).toBeDefined();
  });

  it("rejects claim on already claimed item", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");

    const result = await claimItem(submitted.item!.id, "admin-2");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not pending");
  });

  it("rejects claim on nonexistent item", async () => {
    const result = await claimItem("nonexistent", "admin-1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("unclaimItem", () => {
  it("releases a claimed item back to pending", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");

    const result = await unclaimItem(submitted.item!.id, "admin-1");

    expect(result.success).toBe(true);
    expect(result.item!.status).toBe("pending");
    expect(result.item!.claimedBy).toBeUndefined();
  });

  it("rejects unclaim by different reviewer", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");

    const result = await unclaimItem(submitted.item!.id, "admin-2");

    expect(result.success).toBe(false);
    expect(result.error).toContain("claiming reviewer");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// resolveItem
// ═══════════════════════════════════════════════════════════════════════

describe("resolveItem", () => {
  it("resolves with uphold — no side effects", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");

    const result = await resolveItem({
      itemId: submitted.item!.id,
      reviewerId: "admin-1",
      decision: "uphold",
      reviewerNotes: "Classifier was correct — content violates policy.",
    });

    expect(result.success).toBe(true);
    expect(result.item!.status).toBe("resolved");
    expect(result.item!.decision).toBe("uphold");
    expect(result.item!.resolvedBy).toBe("admin-1");
    expect(result.item!.resolvedAt).toBeDefined();
  });

  it("resolves with overturn — triggers side effects", async () => {
    const submitted = await submitForReview({
      source: "ban_review",
      moderationResult: makeModerationResult({ action: "block" }),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");

    const result = await resolveItem({
      itemId: submitted.item!.id,
      reviewerId: "admin-1",
      decision: "overturn",
      reviewerNotes: "False positive — user was translating historical text.",
    });

    expect(result.success).toBe(true);
    expect(result.item!.decision).toBe("overturn");
    expect(mockSupabase.from).toHaveBeenCalledWith("users");
  });

  it("resolves with modify — requires modifiedAction", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");

    const noAction = await resolveItem({
      itemId: submitted.item!.id,
      reviewerId: "admin-1",
      decision: "modify",
      reviewerNotes: "Severity should be lowered.",
    });

    expect(noAction.success).toBe(false);
    expect(noAction.error).toContain("modifiedAction is required");
  });

  it("resolves with modify — stores modified action", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");

    const result = await resolveItem({
      itemId: submitted.item!.id,
      reviewerId: "admin-1",
      decision: "modify",
      reviewerNotes: "Downgraded to warning.",
      modifiedAction: "warn",
    });

    expect(result.success).toBe(true);
    expect(result.item!.decision).toBe("modify");
    expect(result.item!.modifiedAction).toBe("warn");
  });

  it("rejects resolve by non-claiming reviewer", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");

    const result = await resolveItem({
      itemId: submitted.item!.id,
      reviewerId: "admin-2",
      decision: "uphold",
      reviewerNotes: "Wrong reviewer.",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("claiming reviewer");
  });

  it("rejects resolve on pending item", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });

    const result = await resolveItem({
      itemId: submitted.item!.id,
      reviewerId: "admin-1",
      decision: "uphold",
      reviewerNotes: "Not claimed.",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not claimed");
  });

  it("writes audit log on resolution", async () => {
    const { writeAuditLog } = jest.requireMock("@/platform/auth/audit");
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });
    await claimItem(submitted.item!.id, "admin-1");
    await resolveItem({
      itemId: submitted.item!.id,
      reviewerId: "admin-1",
      decision: "uphold",
      reviewerNotes: "Confirmed violation.",
    });

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_action",
        actorId: "admin-1",
        targetId: "user-1",
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// releaseExpiredClaims + query helpers
// ═══════════════════════════════════════════════════════════════════════

describe("releaseExpiredClaims", () => {
  it("releases items claimed longer than timeout", async () => {
    const submitted = await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });

    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await reviewStore.update(submitted.item!.id, {
      status: "claimed",
      claimedBy: "admin-1",
      claimedAt: oldTime,
    });

    const released = await releaseExpiredClaims();

    expect(released).toBe(1);
  });
});

describe("getQueue", () => {
  it("returns items from the store", async () => {
    await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });

    const items = await getQueue({ status: "pending" });

    expect(items).toHaveLength(1);
  });
});

describe("getQueueStats", () => {
  it("returns statistics from the store", async () => {
    await submitForReview({
      source: "escalation",
      moderationResult: makeModerationResult(),
      targetUserId: "user-1",
      requestId: "req-1",
    });

    const stats = await getQueueStats();

    expect(stats.pendingCount).toBe(1);
    expect(stats.pendingBySource.escalation).toBe(1);
  });
});
