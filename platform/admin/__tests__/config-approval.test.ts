/**
 * platform/admin/__tests__/config-approval.test.ts
 *
 * Tests for the two-person approval service.
 * Covers: create request, approve, reject, self-approval block,
 * expiry detection, duplicate prevention, listing, counting.
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

// Gotcha #34: platform-config mock for getConfig
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn().mockResolvedValue(false),
}));

const mockSupabase = {
  from: jest.fn(),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(() => mockSupabase),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import {
  isApprovalRequired,
  requestApproval,
  approveChange,
  rejectChange,
  listApprovals,
  getApproval,
  countPendingApprovals,
} from "../config-approval";
import { getConfig } from "@/platform/auth/platform-config";

// ── Helpers ─────────────────────────────────────────────────────────────

function createChainMock(resolvedValue: { data: any; error: any }) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(resolvedValue),
    then: (resolve: any) => resolve(resolvedValue),
  };
  return chain;
}

const validApprovalRow = {
  id: "apr-1",
  config_key: "moderation.level2.block_severity",
  current_value: '"medium"',
  proposed_value: '"high"',
  requested_by: "admin-1",
  change_comment: "Tightening thresholds",
  impact_summary: "Block rate may increase for Level 2",
  status: "pending",
  reviewed_by: null,
  review_comment: null,
  reviewed_at: null,
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  created_at: "2026-04-22T12:00:00Z",
};

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe("isApprovalRequired", () => {
  it("returns false when feature is disabled", async () => {
    (getConfig as jest.Mock).mockResolvedValue(false);
    const result = await isApprovalRequired();
    expect(result).toBe(false);
  });

  it("returns true when feature is enabled", async () => {
    (getConfig as jest.Mock).mockResolvedValue(true);
    const result = await isApprovalRequired();
    expect(result).toBe(true);
  });

  it("fails closed on error (P11)", async () => {
    (getConfig as jest.Mock).mockRejectedValue(new Error("DB down"));
    const result = await isApprovalRequired();
    expect(result).toBe(true);
  });
});

describe("requestApproval", () => {
  it("creates a pending approval", async () => {
    // First call: check for existing pending
    const existingChain = createChainMock({ data: [], error: null });
    // Second call: insert new approval
    const insertChain = createChainMock({
      data: validApprovalRow,
      error: null,
    });

    let callCount = 0;
    mockSupabase.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? existingChain : insertChain;
    });

    const result = await requestApproval({
      configKey: "moderation.level2.block_severity",
      currentValue: "medium",
      proposedValue: "high",
      requestedBy: "admin-1",
      changeComment: "Tightening thresholds",
      impactSummary: "Block rate may increase",
    });

    expect(result.success).toBe(true);
    expect(result.record).toBeDefined();
    expect(result.record!.configKey).toBe("moderation.level2.block_severity");
    expect(result.record!.status).toBe("pending");
  });

  it("rejects duplicate pending approval for same key", async () => {
    const existingChain = createChainMock({
      data: [{ id: "existing-1" }],
      error: null,
    });
    mockSupabase.from.mockReturnValue(existingChain);

    const result = await requestApproval({
      configKey: "moderation.level2.block_severity",
      currentValue: "medium",
      proposedValue: "high",
      requestedBy: "admin-1",
      changeComment: "Duplicate",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("pending approval already exists");
  });
});

describe("approveChange", () => {
  it("approves a pending change", async () => {
    const fetchChain = createChainMock({
      data: validApprovalRow,
      error: null,
    });
    const updateChain = createChainMock({
      data: { ...validApprovalRow, status: "approved", reviewed_by: "admin-2" },
      error: null,
    });

    let callCount = 0;
    mockSupabase.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    const result = await approveChange("apr-1", "admin-2", "Looks good");

    expect(result.success).toBe(true);
    expect(result.record!.status).toBe("approved");
  });

  it("blocks self-approval", async () => {
    const fetchChain = createChainMock({
      data: validApprovalRow,
      error: null,
    });
    mockSupabase.from.mockReturnValue(fetchChain);

    const result = await approveChange("apr-1", "admin-1", "Approving my own");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Self-approval is not permitted");
  });

  it("rejects already-approved record", async () => {
    const fetchChain = createChainMock({
      data: { ...validApprovalRow, status: "approved" },
      error: null,
    });
    mockSupabase.from.mockReturnValue(fetchChain);

    const result = await approveChange("apr-1", "admin-2", "Too late");

    expect(result.success).toBe(false);
    expect(result.error).toContain("already approved");
  });

  it("detects and marks expired approvals", async () => {
    const expiredRow = {
      ...validApprovalRow,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    const fetchChain = createChainMock({
      data: expiredRow,
      error: null,
    });
    const updateChain = createChainMock({ data: null, error: null });

    let callCount = 0;
    mockSupabase.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    const result = await approveChange("apr-1", "admin-2", "Expired");

    expect(result.success).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("returns error when approval not found", async () => {
    const fetchChain = createChainMock({ data: null, error: null });
    mockSupabase.from.mockReturnValue(fetchChain);

    const result = await approveChange("nonexistent", "admin-2", "Comment");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("rejectChange", () => {
  it("rejects a pending change", async () => {
    const fetchChain = createChainMock({
      data: validApprovalRow,
      error: null,
    });
    const updateChain = createChainMock({
      data: { ...validApprovalRow, status: "rejected", reviewed_by: "admin-2" },
      error: null,
    });

    let callCount = 0;
    mockSupabase.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    const result = await rejectChange("apr-1", "admin-2", "Too risky");

    expect(result.success).toBe(true);
    expect(result.record!.status).toBe("rejected");
  });

  it("allows self-rejection (requester can cancel their own request)", async () => {
    const fetchChain = createChainMock({
      data: validApprovalRow,
      error: null,
    });
    const updateChain = createChainMock({
      data: { ...validApprovalRow, status: "rejected", reviewed_by: "admin-1" },
      error: null,
    });

    let callCount = 0;
    mockSupabase.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    // Self-rejection is allowed (only self-approval is blocked)
    const result = await rejectChange("apr-1", "admin-1", "Changed my mind");

    expect(result.success).toBe(true);
  });
});

describe("listApprovals", () => {
  it("returns mapped records", async () => {
    const chain = createChainMock({
      data: [validApprovalRow],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await listApprovals({ status: "pending" });

    expect(result).toHaveLength(1);
    expect(result[0].configKey).toBe("moderation.level2.block_severity");
    expect(chain.eq).toHaveBeenCalledWith("status", "pending");
  });

  it("returns empty array on error", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "DB error" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await listApprovals();
    expect(result).toEqual([]);
  });
});

describe("getApproval", () => {
  it("returns a single approval record", async () => {
    const chain = createChainMock({
      data: validApprovalRow,
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getApproval("apr-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("apr-1");
  });

  it("returns null when not found", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "not found" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await getApproval("nonexistent");
    expect(result).toBeNull();
  });
});

describe("countPendingApprovals", () => {
  it("returns count of pending approvals", async () => {
    const chain = createChainMock({
      data: [{ id: "a" }, { id: "b" }, { id: "c" }],
      error: null,
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await countPendingApprovals();
    expect(result).toBe(3);
  });

  it("returns 0 on error", async () => {
    const chain = createChainMock({
      data: null,
      error: { message: "DB error" },
    });
    mockSupabase.from.mockReturnValue(chain);

    const result = await countPendingApprovals();
    expect(result).toBe(0);
  });
});
