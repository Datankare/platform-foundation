/**
 * platform/admin/__tests__/config-impact.test.ts
 *
 * Tests for impact correlation queries.
 * Covers metric aggregation, rating level extraction, summary generation,
 * and the full generateImpactReport flow.
 */

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

// The data layer: each query returns what the test scripts (the SQL itself is proven against
// Postgres in __tests__/db).
const mockQuery = jest.fn();
jest.mock("@/platform/data", () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({ query: mockQuery }),
}));
const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
/** One window's counts row; unset counts are 0. */
const counts = (
  c: Partial<Record<"total" | "block" | "warn" | "allow" | "escalate", number>>
) => ({
  total: 0,
  block: 0,
  warn: 0,
  allow: 0,
  escalate: 0,
  ...c,
});

// ── Imports ─────────────────────────────────────────────────────────────

import { generateImpactReport, isModerationConfig } from "../config-impact";
import type { ConfigHistoryRecord } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

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
    scope: "platform",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
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
    // The window counts as Postgres returns them: 10 screenings, 2 blocks, then 10 and 1.
    mockQuery
      .mockResolvedValueOnce(rows([counts({ total: 10, block: 2, allow: 8 })]))
      .mockResolvedValueOnce(rows([counts({ total: 10, block: 1, allow: 9 })]));

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
    mockQuery.mockResolvedValue(rows([]));

    const change = makeHistoryRecord({
      configKey: "moderation.level2.block_severity",
    });

    await generateImpactReport(change, "2026-04-22T12:00:00Z");

    // The level is the third parameter: content_rating_level = 2
    expect(mockQuery.mock.calls[0][1][2]).toBe(2);
  });

  it("does not filter by level for global moderation keys", async () => {
    mockQuery.mockResolvedValue(rows([]));

    const change = makeHistoryRecord({
      configKey: "moderation.strike_warn_threshold",
    });

    await generateImpactReport(change, "2026-04-22T12:00:00Z");

    // No level: the level parameter is null, which the query reads as "any level"
    expect(mockQuery).toHaveBeenCalled();
    expect(mockQuery.mock.calls.every((c) => c[1][2] === null)).toBe(true);
  });

  it("handles DB errors gracefully (P11)", async () => {
    mockQuery.mockRejectedValue(new Error("connection refused"));

    const change = makeHistoryRecord();
    const report = await generateImpactReport(change, "2026-04-22T12:00:00Z");

    expect(report.before.totalScreenings).toBe(0);
    expect(report.after.totalScreenings).toBe(0);
    expect(report.summary).toContain("Insufficient data");
  });

  it("counts exactly at any volume: never truncated, never approximate (F2)", async () => {
    mockQuery.mockResolvedValue(
      rows([
        counts({ total: 2_000_000, block: 500_000, warn: 100_000, allow: 1_400_000 }),
      ])
    );

    const report = await generateImpactReport(
      makeHistoryRecord(),
      "2026-04-22T12:00:00Z"
    );

    expect(report.before).toEqual({
      totalScreenings: 2_000_000,
      blockCount: 500_000,
      warnCount: 100_000,
      allowCount: 1_400_000,
      escalateCount: 0,
      blockRate: 0.25,
      warnRate: 0.05,
      truncated: false,
    });
    expect(report.summary).not.toContain("approximate");
    // Aggregated by the database: no row cap is sent.
    expect(mockQuery.mock.calls[0][1]).toHaveLength(3);
  });

  it("notes insufficient data when screenings below threshold", async () => {
    mockQuery.mockResolvedValue(rows([counts({ total: 1, allow: 1 })]));

    const change = makeHistoryRecord();
    const report = await generateImpactReport(change, "2026-04-22T12:00:00Z");

    expect(report.summary).toContain("Insufficient data");
  });
});
