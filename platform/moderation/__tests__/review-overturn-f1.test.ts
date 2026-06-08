/**
 * platform/moderation/__tests__/review-overturn-f1.test.ts
 *
 * F1 (Sprint 6 adversarial review — Saboteur): an overturn must restore the
 * account to its PRE-DECISION status, not blanket-reset to "active". Escalations
 * never change account status, so overturning one must not touch the users table
 * at all. Covers the previousAccountStatus restoration branches in
 * applyOverturnSideEffects / restoreAccountStatus.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks ───────────────────────────────────────────────────────────────

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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

import { submitForReview, claimItem, resolveItem } from "../review-service";
import { InMemoryReviewQueueStore, setReviewQueueStore } from "../review-store";
import { InMemoryStrikeStore, setStrikeStore } from "../strikes";
import type { AccountStatus, ModerationResult } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeModerationResult(
  overrides: Partial<ModerationResult> = {}
): ModerationResult {
  return {
    action: "block",
    triggeredBy: "classifier",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    reasoning: "Blocked for test.",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 100,
    classifierCostUsd: 0.001,
    trajectoryId: "traj-f1",
    agentId: "guardian-f1",
    ...overrides,
  };
}

async function submitClaimOverturn(opts: {
  source: "escalation" | "ban_review" | "appeal";
  previousAccountStatus?: AccountStatus;
  action?: ModerationResult["action"];
}) {
  const submitted = await submitForReview({
    source: opts.source,
    moderationResult: makeModerationResult({ action: opts.action ?? "block" }),
    targetUserId: "user-f1",
    requestId: "req-f1",
    previousAccountStatus: opts.previousAccountStatus,
  });
  await claimItem(submitted.item!.id, "rev-1");
  const res = await resolveItem({
    itemId: submitted.item!.id,
    reviewerId: "rev-1",
    decision: "overturn",
    reviewerNotes: "Overturning to exercise F1 restoration branches.",
  });
  return { submitted, res };
}

/** Read the payload passed to the (single) users.update() call this test. */
function lastUpdatePayload(): Record<string, unknown> | undefined {
  const fromMock = mockSupabase.from as jest.Mock;
  if (fromMock.mock.results.length === 0) return undefined;
  const builder = fromMock.mock.results[0].value as { update: jest.Mock };
  if (builder.update.mock.calls.length === 0) return undefined;
  return builder.update.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  setReviewQueueStore(new InMemoryReviewQueueStore());
  setStrikeStore(new InMemoryStrikeStore());
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// F1 — overturn account status restoration
// ═══════════════════════════════════════════════════════════════════════

describe("F1 — overturn account status restoration", () => {
  it("escalation overturn does NOT touch the users table", async () => {
    const { res } = await submitClaimOverturn({
      source: "escalation",
      action: "escalate",
    });

    expect(res.success).toBe(true);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("ban_review overturn restores to the previous status (warned), not active", async () => {
    const { res } = await submitClaimOverturn({
      source: "ban_review",
      previousAccountStatus: "warned",
    });

    expect(res.success).toBe(true);
    expect(mockSupabase.from).toHaveBeenCalledWith("users");

    const payload = lastUpdatePayload();
    expect(payload?.account_status).toBe("warned");
    expect(payload?.banned_at).toBeNull();
    expect(payload?.suspended_until).toBeNull();
    expect(payload?.restricted_until).toBeNull();
  });

  it("ban_review overturn falls back to active when previous status is unknown", async () => {
    const { res } = await submitClaimOverturn({ source: "ban_review" });

    expect(res.success).toBe(true);
    const payload = lastUpdatePayload();
    expect(payload?.account_status).toBe("active");
  });

  it("does NOT clear suspended_until when restoring INTO suspended", async () => {
    const { res } = await submitClaimOverturn({
      source: "ban_review",
      previousAccountStatus: "suspended",
    });

    expect(res.success).toBe(true);
    const payload = lastUpdatePayload();
    expect(payload?.account_status).toBe("suspended");
    expect(payload).not.toHaveProperty("suspended_until");
    expect(payload?.restricted_until).toBeNull();
  });

  it("does NOT clear restricted_until when restoring INTO restricted", async () => {
    const { res } = await submitClaimOverturn({
      source: "ban_review",
      previousAccountStatus: "restricted",
    });

    expect(res.success).toBe(true);
    const payload = lastUpdatePayload();
    expect(payload?.account_status).toBe("restricted");
    expect(payload).not.toHaveProperty("restricted_until");
    expect(payload?.suspended_until).toBeNull();
  });

  it("persists previousAccountStatus on the submitted item", async () => {
    const submitted = await submitForReview({
      source: "ban_review",
      moderationResult: makeModerationResult(),
      targetUserId: "user-f1",
      requestId: "req-f1",
      previousAccountStatus: "warned",
    });

    expect(submitted.item!.previousAccountStatus).toBe("warned");
  });
});
