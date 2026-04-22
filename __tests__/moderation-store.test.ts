/**
 * __tests__/moderation-store.test.ts — ModerationStore tests
 *
 * Tests: InMemoryModerationStore CRUD, filtering by all fields,
 * getter/setter, reset behavior.
 */

import {
  InMemoryModerationStore,
  getModerationStore,
  setModerationStore,
  resetModerationStore,
} from "@/platform/moderation/store";
import type { ModerationAuditRecord } from "@/platform/moderation/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(
  overrides: Partial<ModerationAuditRecord> = {}
): ModerationAuditRecord {
  return {
    inputHash: "abc123",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    triggeredBy: "classifier",
    categoriesFlagged: [],
    confidence: 0.9,
    severity: "low",
    actionTaken: "allow",
    reasoning: "Test reasoning",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    classifierCostUsd: 0,
    trajectoryId: "traj-test",
    agentId: "guardian-test",
    pipelineLatencyMs: 50,
    requestId: "req-001",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryModerationStore
// ---------------------------------------------------------------------------

describe("InMemoryModerationStore", () => {
  let store: InMemoryModerationStore;

  beforeEach(() => {
    store = new InMemoryModerationStore();
  });

  it("starts empty", async () => {
    const records = await store.queryAudits();
    expect(records).toHaveLength(0);
    expect(store.getRecordCount()).toBe(0);
  });

  it("logs and retrieves a record", async () => {
    const record = makeRecord({ inputHash: "hash-1" });
    await store.logAudit(record);

    expect(store.getRecordCount()).toBe(1);
    const results = await store.queryAudits();
    expect(results).toHaveLength(1);
    expect(results[0].inputHash).toBe("hash-1");
  });

  it("stores a copy (not a reference)", async () => {
    const record = makeRecord({ inputHash: "original" });
    await store.logAudit(record);
    record.inputHash = "mutated";

    const results = await store.queryAudits();
    expect(results[0].inputHash).toBe("original");
  });

  // ── Filtering ────────────────────────────────────────────────────

  describe("queryAudits — filtering", () => {
    beforeEach(async () => {
      await store.logAudit(
        makeRecord({
          inputHash: "h1",
          actionTaken: "block",
          direction: "input",
          contentType: "generation",
          contentRatingLevel: 1,
          userId: "user-a",
          trajectoryId: "traj-1",
          timestamp: "2026-04-20T10:00:00Z",
        })
      );
      await store.logAudit(
        makeRecord({
          inputHash: "h2",
          actionTaken: "allow",
          direction: "output",
          contentType: "ai-output",
          contentRatingLevel: 3,
          userId: "user-b",
          trajectoryId: "traj-2",
          timestamp: "2026-04-20T11:00:00Z",
        })
      );
      await store.logAudit(
        makeRecord({
          inputHash: "h3",
          actionTaken: "warn",
          direction: "input",
          contentType: "translation",
          contentRatingLevel: 2,
          userId: "user-a",
          trajectoryId: "traj-3",
          timestamp: "2026-04-20T12:00:00Z",
        })
      );
    });

    it("filters by actionTaken", async () => {
      const results = await store.queryAudits({ actionTaken: "block" });
      expect(results).toHaveLength(1);
      expect(results[0].inputHash).toBe("h1");
    });

    it("filters by direction", async () => {
      const results = await store.queryAudits({ direction: "output" });
      expect(results).toHaveLength(1);
      expect(results[0].inputHash).toBe("h2");
    });

    it("filters by contentType", async () => {
      const results = await store.queryAudits({ contentType: "translation" });
      expect(results).toHaveLength(1);
      expect(results[0].inputHash).toBe("h3");
    });

    it("filters by contentRatingLevel", async () => {
      const results = await store.queryAudits({ contentRatingLevel: 2 });
      expect(results).toHaveLength(1);
      expect(results[0].inputHash).toBe("h3");
    });

    it("filters by userId", async () => {
      const results = await store.queryAudits({ userId: "user-a" });
      expect(results).toHaveLength(2);
    });

    it("filters by trajectoryId", async () => {
      const results = await store.queryAudits({ trajectoryId: "traj-2" });
      expect(results).toHaveLength(1);
      expect(results[0].inputHash).toBe("h2");
    });

    it("filters by since", async () => {
      const results = await store.queryAudits({ since: "2026-04-20T11:00:00Z" });
      expect(results).toHaveLength(2);
    });

    it("filters by before", async () => {
      const results = await store.queryAudits({ before: "2026-04-20T11:00:00Z" });
      expect(results).toHaveLength(1);
      expect(results[0].inputHash).toBe("h1");
    });

    it("respects limit", async () => {
      const results = await store.queryAudits({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("sorts newest first", async () => {
      const results = await store.queryAudits();
      expect(results[0].inputHash).toBe("h3");
      expect(results[2].inputHash).toBe("h1");
    });
  });

  // ── getByInputHash ────────────────────────────────────────────────

  describe("getByInputHash", () => {
    it("returns matching records", async () => {
      await store.logAudit(makeRecord({ inputHash: "target" }));
      await store.logAudit(makeRecord({ inputHash: "other" }));
      await store.logAudit(makeRecord({ inputHash: "target" }));

      const results = await store.getByInputHash("target");
      expect(results).toHaveLength(2);
    });

    it("returns empty for no match", async () => {
      await store.logAudit(makeRecord({ inputHash: "some" }));
      const results = await store.getByInputHash("nonexistent");
      expect(results).toHaveLength(0);
    });
  });

  it("clears all records", async () => {
    await store.logAudit(makeRecord());
    await store.logAudit(makeRecord());
    expect(store.getRecordCount()).toBe(2);

    store.clear();
    expect(store.getRecordCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("ModerationStore singleton", () => {
  afterEach(() => resetModerationStore());

  it("returns a store by default", () => {
    expect(getModerationStore()).toBeTruthy();
  });

  it("setModerationStore swaps and returns previous", () => {
    const original = getModerationStore();
    const custom = new InMemoryModerationStore();

    const previous = setModerationStore(custom);
    expect(previous).toBe(original);
    expect(getModerationStore()).toBe(custom);
  });

  it("resetModerationStore restores fresh instance", () => {
    const custom = new InMemoryModerationStore();
    setModerationStore(custom);
    resetModerationStore();
    expect(getModerationStore()).not.toBe(custom);
  });
});

// ---------------------------------------------------------------------------
// F2: InMemoryStore bounded size
// ---------------------------------------------------------------------------

describe("InMemoryModerationStore — bounded size (F2)", () => {
  it("drops oldest records when exceeding MAX_RECORDS", async () => {
    const store = new InMemoryModerationStore();

    for (let i = 0; i < 10_001; i++) {
      await store.logAudit(
        makeRecord({
          inputHash: `hash-${i}`,
          timestamp: new Date(Date.now() + i).toISOString(),
        })
      );
    }

    expect(store.getRecordCount()).toBe(10_000);

    const oldest = await store.getByInputHash("hash-0");
    expect(oldest).toHaveLength(0);

    const newest = await store.getByInputHash("hash-10000");
    expect(newest).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F7: SupabaseModerationStore server-side guard
// ---------------------------------------------------------------------------

describe("SupabaseModerationStore — server-side guard (F7)", () => {
  it("does not throw in Node.js environment (no window)", async () => {
    const mod = await import("@/platform/moderation/store");
    expect(() => {
      new mod.SupabaseModerationStore("https://example.supabase.co", "test-key");
    }).not.toThrow();
  });
});
