/**
 * platform/moderation/__tests__/strikes-supabase.test.ts
 *
 * Tests for SupabaseStrikeStore with mocked Supabase client.
 * Covers: recordStrike, getActiveStrikes, queryStrikes, expireStrikes, error paths.
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

function createChainMock(resolvedValue: { data: any; error: any }) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(resolvedValue),
    then: (resolve: any) => resolve(resolvedValue),
  };
  return chain;
}

const mockSupabase = {
  from: jest.fn(),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(() => mockSupabase),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import { SupabaseStrikeStore } from "../strikes";
import { logger } from "@/lib/logger";

// ── Helpers ─────────────────────────────────────────────────────────────

const validStrikeRow = {
  id: "strike-uuid-1",
  user_id: "user-1",
  category: "harassment",
  severity: "medium",
  moderation_audit_id: "audit-1",
  trajectory_id: "traj-1",
  agent_id: "sentinel-1",
  reason: "Blocked for harassment",
  expires_at: null,
  expired: false,
  created_at: "2026-04-24T12:00:00Z",
};

function makeStrikeInput() {
  return {
    userId: "user-1",
    category: "harassment",
    severity: "medium" as const,
    moderationAuditId: "audit-1",
    trajectoryId: "traj-1",
    agentId: "sentinel-1",
    reason: "Blocked for harassment",
    expiresAt: null,
    expired: false,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe("SupabaseStrikeStore", () => {
  let store: SupabaseStrikeStore;

  beforeEach(() => {
    store = new SupabaseStrikeStore();
  });

  describe("recordStrike", () => {
    it("inserts a strike and returns the record", async () => {
      const chain = createChainMock({
        data: validStrikeRow,
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await store.recordStrike(makeStrikeInput());

      expect(result.success).toBe(true);
      expect(result.record).toBeDefined();
      expect(result.record!.userId).toBe("user-1");
      expect(result.record!.category).toBe("harassment");
    });

    it("returns error on DB failure (L19: not fire-and-forget)", async () => {
      const chain = createChainMock({
        data: null,
        error: { message: "connection refused" },
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await store.recordStrike(makeStrikeInput());

      expect(result.success).toBe(false);
      expect(result.error).toContain("connection refused");
      expect(logger.error).toHaveBeenCalled();
    });

    it("returns error on exception (L19: not fire-and-forget)", async () => {
      mockSupabase.from.mockImplementation(() => {
        throw new Error("Network timeout");
      });

      const result = await store.recordStrike(makeStrikeInput());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network timeout");
    });
  });

  describe("getActiveStrikes", () => {
    it("returns active strikes filtered by user", async () => {
      const chain = createChainMock({
        data: [validStrikeRow],
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const strikes = await store.getActiveStrikes("user-1");

      expect(strikes).toHaveLength(1);
      expect(strikes[0].userId).toBe("user-1");
      expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
      expect(chain.eq).toHaveBeenCalledWith("expired", false);
    });

    it("filters out time-expired strikes in memory", async () => {
      const expired = {
        ...validStrikeRow,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      };
      const chain = createChainMock({
        data: [expired],
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const strikes = await store.getActiveStrikes("user-1");
      expect(strikes).toHaveLength(0);
    });

    it("returns empty array on error", async () => {
      const chain = createChainMock({
        data: null,
        error: { message: "DB error" },
      });
      mockSupabase.from.mockReturnValue(chain);

      const strikes = await store.getActiveStrikes("user-1");
      expect(strikes).toEqual([]);
    });
  });

  describe("getStrikeSummary", () => {
    it("returns summary from active strikes", async () => {
      const chain = createChainMock({
        data: [
          validStrikeRow,
          { ...validStrikeRow, id: "s2", category: "violence", severity: "high" },
        ],
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const summary = await store.getStrikeSummary("user-1");

      expect(summary.totalActive).toBe(2);
      expect(summary.byCategory["harassment"]).toBe(1);
      expect(summary.byCategory["violence"]).toBe(1);
      expect(summary.highestSeverity).toBe("high");
    });
  });

  describe("queryStrikes", () => {
    it("queries with filters", async () => {
      const chain = createChainMock({
        data: [validStrikeRow],
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await store.queryStrikes({
        userId: "user-1",
        activeOnly: true,
        category: "harassment",
        limit: 10,
      });

      expect(result).toHaveLength(1);
      expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
      expect(chain.eq).toHaveBeenCalledWith("expired", false);
      expect(chain.eq).toHaveBeenCalledWith("category", "harassment");
      expect(chain.limit).toHaveBeenCalledWith(10);
    });

    it("uses default limit of 50", async () => {
      const chain = createChainMock({ data: [], error: null });
      mockSupabase.from.mockReturnValue(chain);

      await store.queryStrikes({ userId: "user-1" });
      expect(chain.limit).toHaveBeenCalledWith(50);
    });

    it("returns empty on error", async () => {
      const chain = createChainMock({
        data: null,
        error: { message: "error" },
      });
      mockSupabase.from.mockReturnValue(chain);

      const result = await store.queryStrikes({ userId: "user-1" });
      expect(result).toEqual([]);
    });
  });

  describe("expireStrikes", () => {
    it("marks expired strikes and returns count", async () => {
      const chain = createChainMock({
        data: [{ id: "s1" }, { id: "s2" }],
        error: null,
      });
      mockSupabase.from.mockReturnValue(chain);

      const count = await store.expireStrikes();
      expect(count).toBe(2);
    });

    it("returns 0 on error", async () => {
      const chain = createChainMock({
        data: null,
        error: { message: "DB error" },
      });
      mockSupabase.from.mockReturnValue(chain);

      const count = await store.expireStrikes();
      expect(count).toBe(0);
    });

    it("returns 0 on exception", async () => {
      mockSupabase.from.mockImplementation(() => {
        throw new Error("crash");
      });

      const count = await store.expireStrikes();
      expect(count).toBe(0);
    });
  });
});
