/**
 * platform/moderation/__tests__/review-store-supabase.test.ts
 *
 * Tests for SupabaseReviewQueueStore with mocked fetch.
 * Covers: submit, getById, getByOriginalDecisionId, update,
 * query, getStats, releaseExpiredClaims, error paths.
 */

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { SupabaseReviewQueueStore } from "../review-store";
import type { ModerationResult } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

const TEST_URL = "https://test.supabase.co";
const TEST_KEY = "test-service-key";

function makeModerationResult(): ModerationResult {
  return {
    action: "escalate",
    triggeredBy: "content-rating",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    reasoning: "Low confidence.",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 250,
    classifierCostUsd: 0.001,
    trajectoryId: "traj-1",
    agentId: "guardian-1",
  };
}

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    source: "escalation",
    priority: "high",
    status: "pending",
    moderation_result: makeModerationResult(),
    target_user_id: "user-1",
    request_id: "req-1",
    explanation_chain: null,
    appeal_reason: null,
    original_decision_id: null,
    claimed_by: null,
    claimed_at: null,
    resolved_by: null,
    resolved_at: null,
    decision: null,
    reviewer_notes: null,
    modified_action: null,
    created_at: "2026-05-30T00:00:00.000Z",
    updated_at: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    json: jest.fn().mockResolvedValue(data),
    text: jest.fn().mockResolvedValue(JSON.stringify(data)),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("SupabaseReviewQueueStore", () => {
  let store: SupabaseReviewQueueStore;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    store = new SupabaseReviewQueueStore(TEST_URL, TEST_KEY);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("submit", () => {
    it("posts to review_queue and returns mapped item", async () => {
      const row = makeDbRow();
      global.fetch = mockFetchResponse([row]);

      const result = await store.submit({
        source: "escalation",
        priority: "high",
        status: "pending",
        moderationResult: makeModerationResult(),
        targetUserId: "user-1",
        requestId: "req-1",
      });

      expect(result.success).toBe(true);
      expect(result.item).toBeDefined();
      expect(result.item!.id).toBe("uuid-1");
      expect(result.item!.source).toBe("escalation");
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/rest/v1/review_queue"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("returns error on HTTP failure", async () => {
      global.fetch = mockFetchResponse("Server error", false, 500);

      const result = await store.submit({
        source: "escalation",
        priority: "high",
        status: "pending",
        moderationResult: makeModerationResult(),
        targetUserId: "user-1",
        requestId: "req-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("500");
    });

    it("returns error on network failure", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("Network down"));

      const result = await store.submit({
        source: "escalation",
        priority: "high",
        status: "pending",
        moderationResult: makeModerationResult(),
        targetUserId: "user-1",
        requestId: "req-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network down");
    });
  });

  describe("getById", () => {
    it("returns mapped item when found", async () => {
      global.fetch = mockFetchResponse([makeDbRow()]);

      const item = await store.getById("uuid-1");

      expect(item).toBeDefined();
      expect(item!.id).toBe("uuid-1");
    });

    it("returns undefined on empty result", async () => {
      global.fetch = mockFetchResponse([]);

      const item = await store.getById("nonexistent");

      expect(item).toBeUndefined();
    });

    it("returns undefined on HTTP error", async () => {
      global.fetch = mockFetchResponse(null, false, 500);

      const item = await store.getById("uuid-1");

      expect(item).toBeUndefined();
    });

    it("returns undefined on network error", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("timeout"));

      const item = await store.getById("uuid-1");

      expect(item).toBeUndefined();
    });
  });

  describe("getByOriginalDecisionId", () => {
    it("returns item when pending appeal exists", async () => {
      const row = makeDbRow({
        source: "appeal",
        original_decision_id: "traj-orig-1",
      });
      global.fetch = mockFetchResponse([row]);

      const item = await store.getByOriginalDecisionId("traj-orig-1");

      expect(item).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("original_decision_id=eq.traj-orig-1"),
        expect.any(Object)
      );
    });

    it("returns undefined on empty result", async () => {
      global.fetch = mockFetchResponse([]);

      const item = await store.getByOriginalDecisionId("nonexistent");

      expect(item).toBeUndefined();
    });

    it("returns undefined on error", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("fail"));

      const item = await store.getByOriginalDecisionId("traj-1");

      expect(item).toBeUndefined();
    });
  });

  describe("update", () => {
    it("patches item and returns updated", async () => {
      const row = makeDbRow({ status: "claimed", claimed_by: "admin-1" });
      global.fetch = mockFetchResponse([row]);

      const result = await store.update("uuid-1", {
        status: "claimed",
        claimedBy: "admin-1",
        claimedAt: "2026-05-30T01:00:00.000Z",
      });

      expect(result.success).toBe(true);
      expect(result.item!.status).toBe("claimed");
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("id=eq.uuid-1"),
        expect.objectContaining({ method: "PATCH" })
      );
    });

    it("returns error on HTTP failure", async () => {
      global.fetch = mockFetchResponse(null, false, 500);

      const result = await store.update("uuid-1", { status: "claimed" });

      expect(result.success).toBe(false);
    });

    it("returns error when no row returned", async () => {
      global.fetch = mockFetchResponse([]);

      const result = await store.update("uuid-1", { status: "claimed" });

      // Array with 0 items — rows[0] is undefined
      expect(result.success).toBe(false);
      expect(result.error).toContain("No row returned");
    });

    it("returns error on network failure", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("timeout"));

      const result = await store.update("uuid-1", { status: "claimed" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
    });
  });

  describe("query", () => {
    it("returns mapped items", async () => {
      global.fetch = mockFetchResponse([makeDbRow(), makeDbRow({ id: "uuid-2" })]);

      const items = await store.query({ status: "pending" });

      expect(items).toHaveLength(2);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("status=eq.pending"),
        expect.any(Object)
      );
    });

    it("passes all filter params", async () => {
      global.fetch = mockFetchResponse([]);

      await store.query({
        source: "appeal",
        priority: "normal",
        targetUserId: "user-1",
        claimedBy: "admin-1",
        since: "2026-01-01",
        before: "2026-12-31",
        limit: 10,
      });

      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toContain("source=eq.appeal");
      expect(url).toContain("priority=eq.normal");
      expect(url).toContain("target_user_id=eq.user-1");
      expect(url).toContain("claimed_by=eq.admin-1");
      expect(url).toContain("limit=10");
    });

    it("returns empty on HTTP error", async () => {
      global.fetch = mockFetchResponse(null, false, 500);

      const items = await store.query();

      expect(items).toHaveLength(0);
    });

    it("returns empty on network error", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("fail"));

      const items = await store.query();

      expect(items).toHaveLength(0);
    });
  });

  describe("getStats", () => {
    it("builds stats from fetched items", async () => {
      global.fetch = mockFetchResponse([
        makeDbRow({ status: "pending", source: "escalation", priority: "high" }),
        makeDbRow({ status: "pending", source: "ban_review", priority: "critical" }),
        makeDbRow({
          status: "resolved",
          resolved_at: "2026-05-30T01:00:00.000Z",
        }),
      ]);

      const stats = await store.getStats();

      expect(stats.pendingCount).toBe(2);
      expect(stats.resolvedCount).toBe(1);
      expect(stats.pendingBySource.escalation).toBe(1);
      expect(stats.pendingBySource.ban_review).toBe(1);
    });

    it("returns empty stats on error", async () => {
      global.fetch = mockFetchResponse(null, false, 500);

      const stats = await store.getStats();

      expect(stats.pendingCount).toBe(0);
    });

    it("returns empty stats on network error", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("fail"));

      const stats = await store.getStats();

      expect(stats.pendingCount).toBe(0);
    });
  });

  describe("releaseExpiredClaims", () => {
    it("patches expired claims and returns count", async () => {
      global.fetch = mockFetchResponse([
        makeDbRow({ id: "uuid-1" }),
        makeDbRow({ id: "uuid-2" }),
      ]);

      const count = await store.releaseExpiredClaims(60_000);

      expect(count).toBe(2);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("status=eq.claimed"),
        expect.objectContaining({ method: "PATCH" })
      );
    });

    it("returns 0 on HTTP error", async () => {
      global.fetch = mockFetchResponse(null, false, 500);

      const count = await store.releaseExpiredClaims(60_000);

      expect(count).toBe(0);
    });

    it("returns 0 on network error", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("fail"));

      const count = await store.releaseExpiredClaims(60_000);

      expect(count).toBe(0);
    });
  });
});
