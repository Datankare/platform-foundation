/**
 * platform/moderation/__tests__/review-store.test.ts
 *
 * Tests for the review queue persistence service.
 * Uses InMemoryReviewQueueStore (no DB mocks needed for store logic).
 * Covers: submit, getById, query, update, stats, claim expiry, dedup.
 */

import { InMemoryReviewQueueStore } from "../review-store";
import type { ReviewQueueItem } from "../review-types";
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
    reasoning: "Low confidence — escalating for human review.",
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

function makeReviewInput(
  overrides: Partial<Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">> = {}
): Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt"> {
  return {
    source: "escalation",
    priority: "high",
    status: "pending",
    moderationResult: makeModerationResult(),
    targetUserId: "user-1",
    requestId: "req-1",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("InMemoryReviewQueueStore", () => {
  let store: InMemoryReviewQueueStore;

  beforeEach(() => {
    store = new InMemoryReviewQueueStore();
  });

  describe("submit", () => {
    it("creates a review item with generated id and timestamps", async () => {
      const result = await store.submit(makeReviewInput());

      expect(result.success).toBe(true);
      expect(result.item).toBeDefined();
      expect(result.item!.id).toMatch(/^review-/);
      expect(result.item!.createdAt).toBeDefined();
      expect(result.item!.updatedAt).toBeDefined();
      expect(result.item!.source).toBe("escalation");
      expect(result.item!.priority).toBe("high");
      expect(result.item!.status).toBe("pending");
    });

    it("assigns sequential ids", async () => {
      const r1 = await store.submit(makeReviewInput());
      const r2 = await store.submit(makeReviewInput());

      expect(r1.item!.id).toBe("review-1");
      expect(r2.item!.id).toBe("review-2");
    });

    it("preserves all fields from input", async () => {
      const input = makeReviewInput({
        source: "appeal",
        priority: "normal",
        appealReason: "I was translating a historical text",
        originalDecisionId: "traj-original-1",
      });
      const result = await store.submit(input);

      expect(result.item!.source).toBe("appeal");
      expect(result.item!.priority).toBe("normal");
      expect(result.item!.appealReason).toBe("I was translating a historical text");
      expect(result.item!.originalDecisionId).toBe("traj-original-1");
    });
  });

  describe("getById", () => {
    it("returns the item when found", async () => {
      const submitted = await store.submit(makeReviewInput());
      const found = await store.getById(submitted.item!.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(submitted.item!.id);
    });

    it("returns undefined when not found", async () => {
      const found = await store.getById("nonexistent");

      expect(found).toBeUndefined();
    });
  });

  describe("getByOriginalDecisionId", () => {
    it("finds pending appeal by original decision id", async () => {
      await store.submit(
        makeReviewInput({
          source: "appeal",
          originalDecisionId: "traj-orig-1",
        })
      );

      const found = await store.getByOriginalDecisionId("traj-orig-1");
      expect(found).toBeDefined();
      expect(found!.originalDecisionId).toBe("traj-orig-1");
    });

    it("ignores resolved appeals", async () => {
      const result = await store.submit(
        makeReviewInput({
          source: "appeal",
          originalDecisionId: "traj-orig-2",
        })
      );
      await store.update(result.item!.id, {
        status: "resolved",
        decision: "uphold",
        resolvedBy: "admin-1",
        resolvedAt: new Date().toISOString(),
      });

      const found = await store.getByOriginalDecisionId("traj-orig-2");
      expect(found).toBeUndefined();
    });

    it("ignores non-appeal sources", async () => {
      await store.submit(
        makeReviewInput({
          source: "escalation",
          originalDecisionId: "traj-orig-3",
        })
      );

      const found = await store.getByOriginalDecisionId("traj-orig-3");
      expect(found).toBeUndefined();
    });
  });

  describe("update", () => {
    it("updates fields on an existing item", async () => {
      const submitted = await store.submit(makeReviewInput());
      const now = new Date().toISOString();

      const updated = await store.update(submitted.item!.id, {
        status: "claimed",
        claimedBy: "admin-1",
        claimedAt: now,
      });

      expect(updated.success).toBe(true);
      expect(updated.item!.status).toBe("claimed");
      expect(updated.item!.claimedBy).toBe("admin-1");
      expect(updated.item!.claimedAt).toBe(now);
    });

    it("returns error for nonexistent item", async () => {
      const result = await store.update("nonexistent", {
        status: "claimed",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("supports full resolution update", async () => {
      const submitted = await store.submit(makeReviewInput());
      const now = new Date().toISOString();

      await store.update(submitted.item!.id, {
        status: "claimed",
        claimedBy: "admin-1",
        claimedAt: now,
      });

      const resolved = await store.update(submitted.item!.id, {
        status: "resolved",
        resolvedBy: "admin-1",
        resolvedAt: now,
        decision: "overturn",
        reviewerNotes: "False positive — user was translating historical text.",
      });

      expect(resolved.success).toBe(true);
      expect(resolved.item!.status).toBe("resolved");
      expect(resolved.item!.decision).toBe("overturn");
      expect(resolved.item!.reviewerNotes).toContain("False positive");
    });
  });

  describe("query", () => {
    beforeEach(async () => {
      await store.submit(makeReviewInput({ source: "escalation", priority: "high" }));
      await store.submit(
        makeReviewInput({
          source: "ban_review",
          priority: "critical",
          targetUserId: "user-2",
        })
      );
      await store.submit(
        makeReviewInput({
          source: "appeal",
          priority: "normal",
          targetUserId: "user-3",
        })
      );
    });

    it("returns all items when no filters", async () => {
      const results = await store.query();
      expect(results).toHaveLength(3);
    });

    it("filters by status", async () => {
      const results = await store.query({ status: "pending" });
      expect(results).toHaveLength(3);

      const claimed = await store.query({ status: "claimed" });
      expect(claimed).toHaveLength(0);
    });

    it("filters by source", async () => {
      const appeals = await store.query({ source: "appeal" });
      expect(appeals).toHaveLength(1);
      expect(appeals[0].source).toBe("appeal");
    });

    it("filters by priority", async () => {
      const critical = await store.query({ priority: "critical" });
      expect(critical).toHaveLength(1);
      expect(critical[0].source).toBe("ban_review");
    });

    it("filters by target user", async () => {
      const results = await store.query({ targetUserId: "user-2" });
      expect(results).toHaveLength(1);
      expect(results[0].targetUserId).toBe("user-2");
    });

    it("sorts by priority descending then createdAt ascending", async () => {
      const results = await store.query();

      expect(results[0].priority).toBe("critical");
      expect(results[1].priority).toBe("high");
      expect(results[2].priority).toBe("normal");
    });

    it("respects limit", async () => {
      const results = await store.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  describe("getStats", () => {
    it("returns correct counts for empty store", async () => {
      const stats = await store.getStats();

      expect(stats.pendingCount).toBe(0);
      expect(stats.claimedCount).toBe(0);
      expect(stats.resolvedCount).toBe(0);
      expect(stats.avgResolutionMs).toBe(0);
    });

    it("counts items by status and source", async () => {
      await store.submit(makeReviewInput({ source: "escalation" }));
      await store.submit(makeReviewInput({ source: "ban_review" }));
      await store.submit(makeReviewInput({ source: "appeal" }));

      const stats = await store.getStats();

      expect(stats.pendingCount).toBe(3);
      expect(stats.pendingBySource.escalation).toBe(1);
      expect(stats.pendingBySource.ban_review).toBe(1);
      expect(stats.pendingBySource.appeal).toBe(1);
    });

    it("counts items by priority", async () => {
      await store.submit(makeReviewInput({ priority: "critical", source: "ban_review" }));
      await store.submit(makeReviewInput({ priority: "high" }));
      await store.submit(makeReviewInput({ priority: "normal", source: "appeal" }));

      const stats = await store.getStats();

      expect(stats.pendingByPriority.critical).toBe(1);
      expect(stats.pendingByPriority.high).toBe(1);
      expect(stats.pendingByPriority.normal).toBe(1);
    });

    it("tracks claimed and resolved counts", async () => {
      const r1 = await store.submit(makeReviewInput());
      const r2 = await store.submit(makeReviewInput());

      await store.update(r1.item!.id, {
        status: "claimed",
        claimedBy: "admin-1",
        claimedAt: new Date().toISOString(),
      });
      await store.update(r2.item!.id, {
        status: "resolved",
        resolvedBy: "admin-1",
        resolvedAt: new Date().toISOString(),
        decision: "uphold",
      });

      const stats = await store.getStats();

      expect(stats.pendingCount).toBe(0);
      expect(stats.claimedCount).toBe(1);
      expect(stats.resolvedCount).toBe(1);
    });
  });

  describe("releaseExpiredClaims", () => {
    it("releases claimed items older than timeout", async () => {
      const submitted = await store.submit(makeReviewInput());
      const oldTime = new Date(Date.now() - 100_000).toISOString();

      await store.update(submitted.item!.id, {
        status: "claimed",
        claimedBy: "admin-1",
        claimedAt: oldTime,
      });

      const released = await store.releaseExpiredClaims(50_000);

      expect(released).toBe(1);

      const item = await store.getById(submitted.item!.id);
      expect(item!.status).toBe("pending");
      expect(item!.claimedBy).toBeUndefined();
    });

    it("does not release recently claimed items", async () => {
      const submitted = await store.submit(makeReviewInput());

      await store.update(submitted.item!.id, {
        status: "claimed",
        claimedBy: "admin-1",
        claimedAt: new Date().toISOString(),
      });

      const released = await store.releaseExpiredClaims(50_000);

      expect(released).toBe(0);

      const item = await store.getById(submitted.item!.id);
      expect(item!.status).toBe("claimed");
    });

    it("does not touch pending or resolved items", async () => {
      await store.submit(makeReviewInput());
      const r2 = await store.submit(makeReviewInput());

      await store.update(r2.item!.id, {
        status: "resolved",
        resolvedBy: "admin-1",
        resolvedAt: new Date().toISOString(),
        decision: "uphold",
      });

      const released = await store.releaseExpiredClaims(0);

      expect(released).toBe(0);
    });
  });

  describe("test helpers", () => {
    it("getItemCount tracks total items", async () => {
      expect(store.getItemCount()).toBe(0);

      await store.submit(makeReviewInput());
      await store.submit(makeReviewInput());

      expect(store.getItemCount()).toBe(2);
    });

    it("clear resets all state", async () => {
      await store.submit(makeReviewInput());
      await store.submit(makeReviewInput());

      store.clear();

      expect(store.getItemCount()).toBe(0);

      const r = await store.submit(makeReviewInput());
      expect(r.item!.id).toBe("review-1");
    });
  });
});
