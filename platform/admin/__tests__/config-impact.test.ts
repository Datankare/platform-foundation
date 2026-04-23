/**
 * platform/admin/__tests__/config-impact.test.ts
 *
 * Tests for impact correlation queries.
 * Covers metric aggregation, rating level extraction, summary generation,
 * and the full generateImpactReport flow.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks ───────────────────────────────────────────────────────────────

// Gotcha #2: jest.mock needs generateRequestId
jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

const mockSupabase = {
  from: jest.fn(),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(() => mockSupabase),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import { generateImpactReport, isModerationConfig } from "../config-impact";
import type { ConfigHistoryRecord } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function createChainMock(resolvedValue: { data: any; error: any }) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: (resolve: any) => resolve(resolvedValue),
  };
  return chain;
}

function makeHistoryRecord(
  overrides: Partial<ConfigHistoryRecord> = {}
): ConfigHistoryRecord {
  return {
    id: "hist-1",
    configKey: "moderation.level2.block_severity",
    previousValue: "medium",
    newValue: "high",
    changedBy: "admin-1",
    changeComment: "Tightening for teens",
    changeSource: "config_agent",
    createdAt: "2026-04-20T12:00:00Z",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe("isModerationConfig", () => {
  it("returns true for moderation keys", () => {
    expect(isModerationConfig("moderation.level1.block_severity")).toBe(true);
    expect(isModerationConfig("moderation.strike_warn_threshold")).toBe(true);
  });

  it("returns false for non-moderation keys", () => {
    expect(isModerationConfig("rate_limit_rpm")).toBe(false);
    expect(isModerationConfig("default_language")).toBe(false);
  });
});

describe("generateImpactReport", () => {
  it("returns report with before/after metrics", async () => {
    const beforeData = [
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "block" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "block" },
    ];
    const afterData = [
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "allow" },
      { action_taken: "block" },
    ];

    let callCount = 0;
    mockSupabase.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return createChainMock({ data: beforeData, error: null });
      }
      return createChainMock({ data: afterData, error: null });
    });

    const change = makeHistoryRecord();
    const report = await generateImpactReport(change, "2026-04-22T12:00:00Z");

    expect(report.change).toBe(change);
    expect(report.before.totalScreenings).toBe(10);
    expect(report.before.blockCount).toBe(2);
    expect(report.before.blockRate).toBeCloseTo(0.2);
    expect(report.after.totalScreenings).toBe(10);
    expect(report.after.blockCount).toBe(1);
    expect(report.after.blockRate).toBeCloseTo(0.1);
    expect(report.summary).toContain("decreased");
  });

  it("filters by content_rating_level for level-specific keys", async () => {
    const chain = createChainMock({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    const change = makeHistoryRecord({
      configKey: "moderation.level2.block_severity",
    });

    await generateImpactReport(change, "2026-04-22T12:00:00Z");

    // Should have called eq with content_rating_level = 2
    expect(chain.eq).toHaveBeenCalledWith("content_rating_level", 2);
  });

  it("does not filter by level for global moderation keys", async () => {
    const chain = createChainMock({ data: [], error: null });
    mockSupabase.from.mockReturnValue(chain);

    const change = makeHistoryRecord({
      configKey: "moderation.strike_warn_threshold",
    });

    await generateImpactReport(change, "2026-04-22T12:00:00Z");

    // eq should NOT be called with content_rating_level
    const eqCalls = chain.eq.mock.calls;
    const hasRatingFilter = eqCalls.some(
      (call: any[]) => call[0] === "content_rating_level"
    );
    expect(hasRatingFilter).toBe(false);
  });

  it("handles DB errors gracefully (P11)", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "connection refused" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const change = makeHistoryRecord();
    const report = await generateImpactReport(change, "2026-04-22T12:00:00Z");

    expect(report.before.totalScreenings).toBe(0);
    expect(report.after.totalScreenings).toBe(0);
    expect(report.summary).toContain("Insufficient data");
  });

  it("notes insufficient data when screenings below threshold", async () => {
    const chain = createChainMock({
      data: [{ action_taken: "allow" }],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const change = makeHistoryRecord();
    const report = await generateImpactReport(change, "2026-04-22T12:00:00Z");

    expect(report.summary).toContain("Insufficient data");
  });
});
