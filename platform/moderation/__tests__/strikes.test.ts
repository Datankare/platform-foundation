/**
 * platform/moderation/__tests__/strikes.test.ts
 *
 * Tests for the strike persistence service.
 * Uses InMemoryStrikeStore (no DB mocks needed for store logic).
 * Covers: recording, active queries, summary, expiry, L19 error surfacing.
 */

import { InMemoryStrikeStore } from "../strikes";
import type { StrikeRecord } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeStrikeInput(
  overrides: Partial<Omit<StrikeRecord, "id" | "createdAt">> = {}
): Omit<StrikeRecord, "id" | "createdAt"> {
  return {
    userId: "user-1",
    category: "harassment",
    severity: "medium",
    moderationAuditId: "audit-1",
    trajectoryId: "traj-1",
    agentId: "sentinel-1",
    reason: "Blocked for harassment",
    expiresAt: null,
    expired: false,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("InMemoryStrikeStore", () => {
  let store: InMemoryStrikeStore;

  beforeEach(() => {
    store = new InMemoryStrikeStore();
  });

  describe("recordStrike", () => {
    it("records a strike and returns the record", async () => {
      const result = await store.recordStrike(makeStrikeInput());

      expect(result.success).toBe(true);
      expect(result.record).toBeDefined();
      expect(result.record!.userId).toBe("user-1");
      expect(result.record!.category).toBe("harassment");
      expect(result.record!.id).toBeTruthy();
      expect(result.record!.createdAt).toBeTruthy();
    });

    it("assigns unique IDs", async () => {
      const r1 = await store.recordStrike(makeStrikeInput());
      const r2 = await store.recordStrike(makeStrikeInput());

      expect(r1.record!.id).not.toBe(r2.record!.id);
    });

    it("increments record count", async () => {
      await store.recordStrike(makeStrikeInput());
      await store.recordStrike(makeStrikeInput());

      expect(store.getRecordCount()).toBe(2);
    });
  });

  describe("getActiveStrikes", () => {
    it("returns active strikes for a user", async () => {
      await store.recordStrike(makeStrikeInput({ userId: "user-1" }));
      await store.recordStrike(makeStrikeInput({ userId: "user-1" }));
      await store.recordStrike(makeStrikeInput({ userId: "user-2" }));

      const strikes = await store.getActiveStrikes("user-1");
      expect(strikes).toHaveLength(2);
    });

    it("excludes expired strikes", async () => {
      await store.recordStrike(makeStrikeInput({ expired: false }));
      await store.recordStrike(makeStrikeInput({ expired: true }));

      const strikes = await store.getActiveStrikes("user-1");
      expect(strikes).toHaveLength(1);
    });

    it("excludes time-expired strikes even if expired flag is false", async () => {
      await store.recordStrike(
        makeStrikeInput({
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          expired: false,
        })
      );
      await store.recordStrike(makeStrikeInput({ expiresAt: null }));

      const strikes = await store.getActiveStrikes("user-1");
      expect(strikes).toHaveLength(1);
    });

    it("includes strikes with no expiry (null expiresAt)", async () => {
      await store.recordStrike(makeStrikeInput({ expiresAt: null }));

      const strikes = await store.getActiveStrikes("user-1");
      expect(strikes).toHaveLength(1);
    });

    it("returns newest first", async () => {
      await store.recordStrike(makeStrikeInput({ category: "first" }));
      await store.recordStrike(makeStrikeInput({ category: "second" }));

      const strikes = await store.getActiveStrikes("user-1");
      expect(strikes[0].category).toBe("second");
    });
  });

  describe("getStrikeSummary", () => {
    it("returns zero summary for clean user", async () => {
      const summary = await store.getStrikeSummary("user-clean");

      expect(summary.totalActive).toBe(0);
      expect(summary.mostRecent).toBeNull();
      expect(summary.highestSeverity).toBeNull();
      expect(Object.keys(summary.byCategory)).toHaveLength(0);
    });

    it("counts per category", async () => {
      await store.recordStrike(makeStrikeInput({ category: "harassment" }));
      await store.recordStrike(makeStrikeInput({ category: "harassment" }));
      await store.recordStrike(makeStrikeInput({ category: "violence" }));

      const summary = await store.getStrikeSummary("user-1");

      expect(summary.totalActive).toBe(3);
      expect(summary.byCategory["harassment"]).toBe(2);
      expect(summary.byCategory["violence"]).toBe(1);
    });

    it("tracks highest severity", async () => {
      await store.recordStrike(makeStrikeInput({ severity: "low" }));
      await store.recordStrike(makeStrikeInput({ severity: "critical" }));
      await store.recordStrike(makeStrikeInput({ severity: "medium" }));

      const summary = await store.getStrikeSummary("user-1");
      expect(summary.highestSeverity).toBe("critical");
    });

    it("sets mostRecent to newest strike", async () => {
      await store.recordStrike(makeStrikeInput({ category: "old" }));
      await store.recordStrike(makeStrikeInput({ category: "newest" }));

      const summary = await store.getStrikeSummary("user-1");
      expect(summary.mostRecent!.category).toBe("newest");
    });
  });

  describe("queryStrikes", () => {
    it("returns all strikes for a user", async () => {
      await store.recordStrike(makeStrikeInput());
      await store.recordStrike(makeStrikeInput({ expired: true }));

      const all = await store.queryStrikes({
        userId: "user-1",
      });
      expect(all).toHaveLength(2);
    });

    it("filters by activeOnly", async () => {
      await store.recordStrike(makeStrikeInput());
      await store.recordStrike(makeStrikeInput({ expired: true }));

      const active = await store.queryStrikes({
        userId: "user-1",
        activeOnly: true,
      });
      expect(active).toHaveLength(1);
    });

    it("filters by category", async () => {
      await store.recordStrike(makeStrikeInput({ category: "harassment" }));
      await store.recordStrike(makeStrikeInput({ category: "violence" }));

      const result = await store.queryStrikes({
        userId: "user-1",
        category: "violence",
      });
      expect(result).toHaveLength(1);
      expect(result[0].category).toBe("violence");
    });

    it("respects limit", async () => {
      await store.recordStrike(makeStrikeInput());
      await store.recordStrike(makeStrikeInput());
      await store.recordStrike(makeStrikeInput());

      const result = await store.queryStrikes({
        userId: "user-1",
        limit: 2,
      });
      expect(result).toHaveLength(2);
    });
  });

  describe("expireStrikes", () => {
    it("marks time-expired strikes as expired", async () => {
      await store.recordStrike(
        makeStrikeInput({
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        })
      );
      await store.recordStrike(makeStrikeInput({ expiresAt: null }));

      const count = await store.expireStrikes();

      expect(count).toBe(1);
      const active = await store.getActiveStrikes("user-1");
      expect(active).toHaveLength(1);
    });

    it("does not expire strikes with future expiresAt", async () => {
      await store.recordStrike(
        makeStrikeInput({
          expiresAt: new Date(Date.now() + 100_000).toISOString(),
        })
      );

      const count = await store.expireStrikes();
      expect(count).toBe(0);
    });

    it("does not double-expire already expired strikes", async () => {
      await store.recordStrike(
        makeStrikeInput({
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        })
      );

      await store.expireStrikes();
      const count = await store.expireStrikes();
      expect(count).toBe(0);
    });
  });

  describe("clear (test helper)", () => {
    it("removes all records", async () => {
      await store.recordStrike(makeStrikeInput());
      await store.recordStrike(makeStrikeInput());

      store.clear();

      expect(store.getRecordCount()).toBe(0);
      const strikes = await store.getActiveStrikes("user-1");
      expect(strikes).toHaveLength(0);
    });
  });
});
