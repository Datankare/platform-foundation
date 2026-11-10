/**
 * platform/admin/__tests__/config-approval.test.ts
 *
 * The two-person approval flag (fail closed) and the service's failure paths. The workflow —
 * requests, approval, self-approval, conflicts, expiry, per-tenant visibility — runs against
 * Postgres in __tests__/db/platform-config.db.test.ts.
 */

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

// Gotcha #34: platform-config mock for getConfig
jest.mock("@/platform/auth/platform-config", () => ({
  getConfigOrThrow: jest.fn().mockResolvedValue(false),
  // The setting's tier names who could approve it (TASK-203, N-24).
  getPermissionTier: jest.fn().mockResolvedValue("standard"),
}));

// The workflow itself is proven against Postgres (__tests__/db/platform-config.db.test.ts);
// here only the flag and the failure paths.
const mockTx = jest.fn();
jest.mock("@/platform/data", () => ({ withTenantTx: (fn: unknown) => mockTx(fn) }));

// ── Imports ─────────────────────────────────────────────────────────────

import { logger } from "@/lib/logger";
import {
  isApprovalRequired,
  requestApproval,
  approveChange,
  listApprovals,
  getApproval,
  countPendingApprovals,
} from "../config-approval";
import { getConfigOrThrow } from "@/platform/auth/platform-config";

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe("isApprovalRequired", () => {
  it("returns false when feature is disabled", async () => {
    (getConfigOrThrow as jest.Mock).mockResolvedValue(false);
    const result = await isApprovalRequired();
    expect(result).toBe(false);
  });

  it("returns true when feature is enabled", async () => {
    (getConfigOrThrow as jest.Mock).mockResolvedValue(true);
    const result = await isApprovalRequired();
    expect(result).toBe(true);
  });

  it.each([
    ["a missing flag", new Error("not found")],
    ["an unreadable flag", new Error("DB down")],
  ])(
    "fails closed on %s — the default no longer switches approval off",
    async (_label, err) => {
      (getConfigOrThrow as jest.Mock).mockRejectedValue(err);
      await expect(isApprovalRequired()).resolves.toBe(true);
    }
  );

  it.each([
    ['the string "false"', "false"],
    ["null", null],
    ["0", 0],
  ])(
    "treats %s as enabled: only the boolean false disables it",
    async (_label, value) => {
      (getConfigOrThrow as jest.Mock).mockResolvedValue(value);
      await expect(isApprovalRequired()).resolves.toBe(true);
    }
  );

  it("fails closed on error (P11)", async () => {
    (getConfigOrThrow as jest.Mock).mockRejectedValue(new Error("DB down"));
    const result = await isApprovalRequired();
    expect(result).toBe(true);
  });
});

describe("when the database fails", () => {
  beforeEach(() => mockTx.mockRejectedValue(new Error("db down")));

  it("a request reports the failure", async () => {
    const r = await requestApproval({
      configKey: "k",
      currentValue: 1,
      proposedValue: 2,
      requestedBy: "00000000-0000-4000-8000-000000000001",
      changeComment: "c",
    });
    // Coded (TASK-194 round 13, I-C): the service is unavailable. Its text is logged, never
    // returned (round 14, item 12: it reached the client as data.error / data.approvalError).
    expect(r).toEqual({
      success: false,
      error: "The approval store is unavailable.",
      errorCode: "service.unavailable",
      errorParams: { service: "config" },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "db down" })
    );
  });

  it("a review reports the failure and decides nothing", async () => {
    const r = await approveChange(
      "00000000-0000-4000-8000-0000000000aa",
      "00000000-0000-4000-8000-000000000002",
      "ok"
    );
    // Coded (TASK-194 round 13, I-C): the service is unavailable. Its text is logged, never
    // returned (round 14, item 12: it reached the client as data.error / data.approvalError).
    expect(r).toEqual({
      success: false,
      error: "The approval store is unavailable.",
      errorCode: "service.unavailable",
      errorParams: { service: "config" },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "db down" })
    );
  });

  it("reads answer empty, never throw", async () => {
    await expect(listApprovals()).resolves.toEqual([]);
    await expect(getApproval("00000000-0000-4000-8000-0000000000aa")).resolves.toBeNull();
    await expect(countPendingApprovals()).resolves.toBe(0);
  });
});
