/**
 * platform/admin/__tests__/pending-approvals.test.ts — ADR-040 040a read model.
 * Merges both hold sources, derives requiredPermission from tier, isolates a failing source.
 */
jest.mock("@/platform/agents/proposal-store", () => ({ getProposalStore: jest.fn() }));
jest.mock("@/platform/admin/config-approval", () => ({ listApprovals: jest.fn() }));
jest.mock("@/platform/auth/platform-config", () => ({
  getPermissionTier: jest.fn(async () => "safety"),
}));

import { getProposalStore } from "@/platform/agents/proposal-store";
import { listApprovals } from "@/platform/admin/config-approval";
import { getPermissionTier } from "@/platform/auth/platform-config";
import { listPendingApprovals } from "../pending-approvals";

const mockStore = getProposalStore as jest.Mock;
const mockList = listApprovals as jest.Mock;
const mockTier = getPermissionTier as jest.Mock;

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: "p1",
    operationId: "op1",
    sessionId: "s1",
    trajectoryId: "t1",
    label: "config.set",
    status: "proposed",
    actor: { actorType: "user", actorId: "admin-1" },
    effects: ["restricted"],
    effectiveRisk: "restricted",
    payload: { key: "moderation.strike_ban_threshold" },
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    configKey: "moderation.blocklist_only_surfaces",
    currentValue: 1,
    proposedValue: 2,
    requestedBy: "admin-2",
    changeComment: "",
    impactSummary: "raises the blocklist scope",
    status: "pending",
    reviewedBy: null,
    reviewComment: null,
    reviewedAt: null,
    expiresAt: "2026-02-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTier.mockResolvedValue("safety");
  mockStore.mockReturnValue({ query: jest.fn().mockResolvedValue([proposal()]) });
  mockList.mockResolvedValue([approval()]);
});

describe("listPendingApprovals — ADR-040 040a", () => {
  it("merges both sources, newest first, each with requiredPermission", async () => {
    const out = await listPendingApprovals();
    expect(out).toHaveLength(2);
    // p1 (01-02) is newer than a1 (01-01)
    expect(out[0].source).toBe("runtime");
    expect(out[0].id).toBe("p1");
    expect(out[0].requester).toBe("admin-1");
    expect(out[0].requiredPermission).toBe("config_manage_safety");
    expect(out[1].source).toBe("config-approval");
    expect(out[1].label).toBe("moderation.blocklist_only_surfaces");
    expect(out[1].requester).toBe("admin-2");
    expect(out[1].reason).toMatch(/blocklist/i);
  });

  it("derives config_manage_standard for standard-tier keys", async () => {
    mockTier.mockResolvedValue("standard");
    const out = await listPendingApprovals();
    expect(out.every((a) => a.requiredPermission === "config_manage_standard")).toBe(
      true
    );
  });

  it("isolates a failing source — config-approval down, runtime still lists", async () => {
    mockList.mockRejectedValue(new Error("db down"));
    const out = await listPendingApprovals();
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("runtime");
  });

  it("falls back to config_manage_safety when a runtime proposal names no config key", async () => {
    mockStore.mockReturnValue({
      query: jest.fn().mockResolvedValue([proposal({ payload: {} })]),
    });
    mockList.mockResolvedValue([]);
    const out = await listPendingApprovals();
    expect(out[0].requiredPermission).toBe("config_manage_safety");
  });
});
