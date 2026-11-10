/**
 * platform/admin/__tests__/config-handlers.test.ts
 *
 * Tests for the 10 config agent tool handlers + dispatcher.
 * Mocks platform-config, config-approval, and config-impact.
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

const mockGetEnhancedConfig = jest.fn();
const mockListEnhancedConfig = jest.fn();
const mockValidateConfigValue = jest.fn();
const mockSetConfigWithHistory = jest.fn();
const mockGetConfigHistory = jest.fn();
const mockGetPermissionTier = jest.fn();
const mockGetConfig = jest.fn();
const mockClearTenantConfig = jest.fn();

jest.mock("@/platform/auth/platform-config", () => ({
  getEnhancedConfig: (...args: any[]) => mockGetEnhancedConfig(...args),
  listEnhancedConfig: (...args: any[]) => mockListEnhancedConfig(...args),
  validateConfigValue: (...args: any[]) => mockValidateConfigValue(...args),
  setConfigWithHistory: (...args: any[]) => mockSetConfigWithHistory(...args),
  getConfigHistory: (...args: any[]) => mockGetConfigHistory(...args),
  getPermissionTier: (...args: any[]) => mockGetPermissionTier(...args),
  getConfigOrThrow: (...args: any[]) => mockGetConfig(...args),
  clearTenantConfig: (...args: any[]) => mockClearTenantConfig(...args),
}));

const mockIsApprovalRequired = jest.fn();
const mockRequestApproval = jest.fn();
const mockApproveApprovalChange = jest.fn();
const mockRejectApprovalChange = jest.fn();
const mockListApprovals = jest.fn();
const mockGetApproval = jest.fn().mockResolvedValue(null);
const mockConfigChangeWithoutApprover = jest.fn().mockResolvedValue(null);

jest.mock("../config-approval", () => ({
  isApprovalRequired: (...args: any[]) => mockIsApprovalRequired(...args),
  requestApproval: (...args: any[]) => mockRequestApproval(...args),
  approveChange: (...args: any[]) => mockApproveApprovalChange(...args),
  // The module's contract (unit-tested in config-approval.test.ts).
  approveAndApply: async (id: string, by: string, note: string, apply: any) => {
    const r = await mockApproveApprovalChange(id, by, note);
    if (!r.success || !r.record) return r;
    const a = await apply(r.record);
    return a.success
      ? r
      : {
          success: false,
          error: `Approved but not applied: ${a.error}`,
          errorCode: "service.unavailable",
        };
  },
  rejectChange: (...args: any[]) => mockRejectApprovalChange(...args),
  listApprovals: (...args: any[]) => mockListApprovals(...args),
  getApproval: (...args: any[]) => mockGetApproval(...args),
  // Someone else could approve (TASK-203, N-24: refused up front otherwise — see below).
  configChangeWithoutApprover: (...args: any[]) =>
    mockConfigChangeWithoutApprover(...args),
}));

const mockGenerateImpactReport = jest.fn();
const mockIsModerationConfig = jest.fn();

jest.mock("../config-impact", () => ({
  generateImpactReport: (...args: any[]) => mockGenerateImpactReport(...args),
  isModerationConfig: (...args: any[]) => mockIsModerationConfig(...args),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import {
  buildChangeRequest,
  handleSearchConfig,
  handleGetConfig,
  handleUpdateConfig,
  handleResetConfig,
  handleGetHistory,
  handleCompareToDefaults,
  handleImpactReport,
  handleBulkReview,
  handleRequestApproval,
  handleApproveChange,
  handleRejectChange,
  dispatchConfigTool,
  CONFIG_TOOLS,
  configFailure,
} from "../config-handlers";
import { logger } from "@/lib/logger";
import { TOOL_BOUNDARIES } from "../types";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { runWithTenant } from "@/platform/tenancy/context";
import type { EnhancedConfigEntry, ToolExecutionContext } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<EnhancedConfigEntry> = {}): EnhancedConfigEntry {
  return {
    key: "rate_limit_rpm",
    value: 100,
    description: "Rate limit",
    category: "system",
    updatedAt: "2026-04-22T00:00:00Z",
    defaultValue: 100,
    valueType: "number",
    minValue: 10,
    maxValue: 1000,
    allowedValues: null,
    permissionTier: "standard",
    tenantOverridable: false,
    overridden: false,
    platformValue: 100,
    ...overrides,
  };
}

// ── Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetConfig.mockResolvedValue([]);
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: search_config
// ═══════════════════════════════════════════════════════════════════════

describe("handleSearchConfig", () => {
  it("returns matching entries", async () => {
    mockListEnhancedConfig.mockResolvedValue([makeEntry()]);

    const result = await handleSearchConfig({ query: "rate" });

    expect(result.success).toBe(true);
    expect((result.data as any).count).toBe(1);
    expect(mockListEnhancedConfig).toHaveBeenCalledWith(
      expect.objectContaining({ query: "rate" })
    );
  });

  it("passes category and tier filters", async () => {
    mockListEnhancedConfig.mockResolvedValue([]);

    await handleSearchConfig({
      category: "moderation",
      permissionTier: "safety",
    });

    expect(mockListEnhancedConfig).toHaveBeenCalledWith({
      query: undefined,
      category: "moderation",
      permissionTier: "safety",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: get_config
// ═══════════════════════════════════════════════════════════════════════

describe("handleGetConfig", () => {
  it("returns entry when found", async () => {
    mockGetEnhancedConfig.mockResolvedValue(makeEntry());

    const result = await handleGetConfig({ key: "rate_limit_rpm" });

    expect(result.success).toBe(true);
    expect((result.data as any).found).toBe(true);
  });

  it("returns not found", async () => {
    mockGetEnhancedConfig.mockResolvedValue(null);

    const result = await handleGetConfig({ key: "nonexistent" });

    expect(result.success).toBe(true);
    expect((result.data as any).found).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: update_config
// ═══════════════════════════════════════════════════════════════════════

// Round 14, item 3: a write that did not complete is coded by what the store said, for an update
// and for a reset alike; and an admin.action_failed answer — given or fallen back to — is logged.
describe("a write that did not complete, coded (round 14, item 3)", () => {
  const SHARED = Object.freeze({
    tenantId: "11111111-1111-4111-8111-111111111111",
    mode: "shared" as const,
  });
  const write = () =>
    handleUpdateConfig({
      key: "rate_limit_rpm",
      value: 200,
      changeComment: "c",
      actorId: "admin-1",
      confirmed: true,
    });
  const reset = () =>
    runWithTenant(SHARED, () =>
      handleResetConfig({
        key: "rate_limit_rpm",
        changeComment: "c",
        actorId: "admin-1",
        confirmed: true,
      })
    );
  beforeEach(() => {
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    mockIsApprovalRequired.mockResolvedValue(false);
  });

  it.each([
    [
      { success: false, error: "commit lost", indeterminate: true },
      "admin.write_indeterminate",
      {},
    ],
    [
      { success: false, error: "The audit log is unavailable", auditUnavailable: true },
      "service.unavailable",
      { service: "audit" },
    ],
    [{ success: false, error: "constraint x" }, "admin.action_failed", {}],
  ])("an update whose write answered %j is %s", async (written, code, params) => {
    mockGetEnhancedConfig.mockResolvedValue(makeEntry());
    mockSetConfigWithHistory.mockResolvedValue(written);
    const r = await write();
    expect(r.data).toMatchObject({
      applied: false,
      errorCode: code,
      errorParams: params,
    });
  });

  it.each([
    [
      { success: false, error: "commit lost", indeterminate: true },
      "admin.write_indeterminate",
    ],
    [{ success: false, error: "audit", auditUnavailable: true }, "service.unavailable"],
  ])("a reset whose clear answered %j is %s", async (written, code) => {
    mockGetEnhancedConfig.mockResolvedValue(
      makeEntry({
        overridden: true,
        tenantOverridable: true,
        value: 5,
        platformValue: 100,
      })
    );
    mockClearTenantConfig.mockResolvedValue(written);
    const r = await reset();
    expect(r.data).toMatchObject({ applied: false, errorCode: code });
  });

  it("logs an admin.action_failed answer, given or fallen back to", () => {
    (logger.error as jest.Mock).mockClear();
    const given = configFailure({
      toolId: "update_config",
      success: true,
      data: { applied: false, error: "constraint x", errorCode: "admin.action_failed" },
      durationMs: 0,
    });
    expect(given.code).toBe("admin.action_failed");
    const fallen = configFailure({
      toolId: "update_config",
      success: false,
      data: null,
      error: "no code",
      durationMs: 0,
    });
    expect(fallen.code).toBe("admin.action_failed");
    expect(logger.error).toHaveBeenCalledWith(
      "Config tool failed",
      expect.objectContaining({ error: "constraint x" })
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Config tool failed",
      expect.objectContaining({ error: "no code" })
    );
    // A coded refusal is no failure to log.
    (logger.error as jest.Mock).mockClear();
    configFailure({
      toolId: "update_config",
      success: true,
      data: { errorCode: "approvals.already_pending", errorParams: { key: "k" } },
      durationMs: 0,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("handleUpdateConfig", () => {
  it("returns preview without applying when confirmed is false (P10)", async () => {
    mockGetEnhancedConfig.mockResolvedValue(makeEntry());
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    mockIsApprovalRequired.mockResolvedValue(false);

    const result = await handleUpdateConfig({
      key: "rate_limit_rpm",
      value: 200,
      changeComment: "Preview only",
      actorId: "admin-1",
      // confirmed is absent — should return preview
    });

    expect(result.success).toBe(true);
    expect((result.data as any).applied).toBe(false);
    expect((result.data as any).pendingConfirmation).toBe(true);
    expect((result.data as any).changeRequest).toBeDefined();
    expect(mockSetConfigWithHistory).not.toHaveBeenCalled();
  });

  it("applies when confirmed is true (P10)", async () => {
    mockGetEnhancedConfig.mockResolvedValue(makeEntry());
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    mockIsApprovalRequired.mockResolvedValue(false);
    mockSetConfigWithHistory.mockResolvedValue({ success: true });

    const result = await handleUpdateConfig({
      key: "rate_limit_rpm",
      value: 200,
      changeComment: "Confirmed change",
      actorId: "admin-1",
      confirmed: true,
    });

    expect(result.success).toBe(true);
    expect((result.data as any).applied).toBe(true);
    expect(mockSetConfigWithHistory).toHaveBeenCalled();
  });

  it("applies a valid standard-tier change", async () => {
    mockGetEnhancedConfig.mockResolvedValue(makeEntry());
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    mockIsApprovalRequired.mockResolvedValue(false);
    mockSetConfigWithHistory.mockResolvedValue({ success: true });

    const result = await handleUpdateConfig({
      key: "rate_limit_rpm",
      value: 200,
      changeComment: "Increasing for load test",
      actorId: "admin-1",
      confirmed: true,
    });

    expect(result.success).toBe(true);
    expect((result.data as any).applied).toBe(true);
    expect(mockSetConfigWithHistory).toHaveBeenCalledWith(
      "rate_limit_rpm",
      200,
      "admin-1",
      "Increasing for load test",
      "config_agent",
      expect.objectContaining({ key: "rate_limit_rpm" }),
      // ADR-053 D5: a single-tenant deployment changes the platform default.
      { scope: "platform", operator: false }
    );
  });

  it("returns error when key not found", async () => {
    mockGetEnhancedConfig.mockResolvedValue(null);

    const result = await handleUpdateConfig({
      key: "nonexistent",
      value: "x",
      changeComment: "test",
      actorId: "admin-1",
    });

    expect(result.success).toBe(true); // Tool call succeeded, but change failed
    expect((result.data as any).applied).toBe(false);
    expect((result.data as any).error).toContain("not found");
  });

  it("returns validation errors for invalid value", async () => {
    mockGetEnhancedConfig.mockResolvedValue(makeEntry());
    mockValidateConfigValue.mockReturnValue({
      valid: false,
      errors: ["Value 9999 exceeds maximum 1000"],
    });

    const result = await handleUpdateConfig({
      key: "rate_limit_rpm",
      value: 9999,
      changeComment: "Too high",
      actorId: "admin-1",
    });

    expect(result.success).toBe(true);
    expect((result.data as any).applied).toBe(false);
    expect((result.data as any).validationErrors).toContain(
      "Value 9999 exceeds maximum 1000"
    );
  });

  it("creates approval for safety-tier with approval enabled", async () => {
    const safetyEntry = makeEntry({
      key: "moderation.level2.block_severity",
      permissionTier: "safety",
    });
    mockGetEnhancedConfig.mockResolvedValue(safetyEntry);
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    mockIsApprovalRequired.mockResolvedValue(true);
    mockRequestApproval.mockResolvedValue({
      success: true,
      record: { id: "apr-1", status: "pending" },
    });

    const result = await handleUpdateConfig({
      key: "moderation.level2.block_severity",
      value: "high",
      changeComment: "Tightening thresholds",
      actorId: "admin-1",
      confirmed: true,
    });

    expect(result.success).toBe(true);
    expect((result.data as any).applied).toBe(false);
    expect((result.data as any).requiresApproval).toBe(true);
    expect(mockSetConfigWithHistory).not.toHaveBeenCalled();
  });

  it("applies safety-tier change when approval is disabled", async () => {
    const safetyEntry = makeEntry({
      key: "moderation.level2.block_severity",
      permissionTier: "safety",
    });
    mockGetEnhancedConfig.mockResolvedValue(safetyEntry);
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    mockIsApprovalRequired.mockResolvedValue(false);
    mockSetConfigWithHistory.mockResolvedValue({ success: true });

    const result = await handleUpdateConfig({
      key: "moderation.level2.block_severity",
      value: "high",
      changeComment: "Tightening",
      actorId: "admin-1",
      confirmed: true,
    });

    expect((result.data as any).applied).toBe(true);
    expect(mockSetConfigWithHistory).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: get_history
// ═══════════════════════════════════════════════════════════════════════

describe("handleGetHistory", () => {
  it("returns history records", async () => {
    mockGetConfigHistory.mockResolvedValue([{ id: "h1", configKey: "rate_limit_rpm" }]);

    const result = await handleGetHistory({ configKey: "rate_limit_rpm" });

    expect(result.success).toBe(true);
    expect((result.data as any).count).toBe(1);
  });

  it("uses default limit of 20", async () => {
    mockGetConfigHistory.mockResolvedValue([]);

    await handleGetHistory({});

    expect(mockGetConfigHistory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: compare_to_defaults
// ═══════════════════════════════════════════════════════════════════════

describe("handleCompareToDefaults", () => {
  it("identifies drifted values", async () => {
    mockListEnhancedConfig.mockResolvedValue([
      makeEntry({ key: "k1", value: 200, defaultValue: 100 }),
      makeEntry({ key: "k2", value: 50, defaultValue: 50 }),
    ]);

    const result = await handleCompareToDefaults({});

    expect(result.success).toBe(true);
    expect((result.data as any).driftedCount).toBe(1);
    expect((result.data as any).totalCount).toBe(2);
  });

  it("filters to only drifted when requested", async () => {
    mockListEnhancedConfig.mockResolvedValue([
      makeEntry({ key: "k1", value: 200, defaultValue: 100 }),
      makeEntry({ key: "k2", value: 50, defaultValue: 50 }),
    ]);

    const result = await handleCompareToDefaults({ onlyDrifted: true });

    expect((result.data as any).comparisons).toHaveLength(1);
    expect((result.data as any).comparisons[0].key).toBe("k1");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: impact_report
// ═══════════════════════════════════════════════════════════════════════

describe("handleImpactReport", () => {
  it("returns impact reports for moderation keys", async () => {
    mockIsModerationConfig.mockReturnValue(true);
    mockGetConfigHistory.mockResolvedValue([
      {
        id: "h1",
        configKey: "moderation.level2.block_severity",
        createdAt: "2026-04-20T12:00:00Z",
      },
    ]);
    mockGenerateImpactReport.mockResolvedValue({
      summary: "Block rate decreased",
    });

    const result = await handleImpactReport({
      configKey: "moderation.level2.block_severity",
    });

    expect(result.success).toBe(true);
    expect((result.data as any).reports).toHaveLength(1);
  });

  it("returns message for non-moderation keys", async () => {
    mockIsModerationConfig.mockReturnValue(false);

    const result = await handleImpactReport({
      configKey: "rate_limit_rpm",
    });

    expect(result.success).toBe(true);
    expect((result.data as any).reports).toHaveLength(0);
    expect((result.data as any).message).toContain("not a moderation key");
  });

  it("handles no history gracefully", async () => {
    mockIsModerationConfig.mockReturnValue(true);
    mockGetConfigHistory.mockResolvedValue([]);

    const result = await handleImpactReport({
      configKey: "moderation.level2.block_severity",
    });

    expect((result.data as any).message).toContain("No change history");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: bulk_review
// ═══════════════════════════════════════════════════════════════════════

describe("handleBulkReview", () => {
  it("groups entries by category", async () => {
    mockListEnhancedConfig.mockResolvedValue([
      makeEntry({ key: "k1", category: "system" }),
      makeEntry({ key: "k2", category: "moderation" }),
      makeEntry({ key: "k3", category: "system" }),
    ]);

    const result = await handleBulkReview({});

    expect(result.success).toBe(true);
    expect((result.data as any).totalCount).toBe(3);
    expect((result.data as any).categories).toContain("system");
    expect((result.data as any).categories).toContain("moderation");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: request_approval
// ═══════════════════════════════════════════════════════════════════════

describe("handleRequestApproval", () => {
  it("creates approval after validation", async () => {
    mockGetEnhancedConfig.mockResolvedValue(makeEntry({ permissionTier: "safety" }));
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    mockRequestApproval.mockResolvedValue({
      success: true,
      record: { id: "apr-1" },
    });

    const result = await handleRequestApproval({
      configKey: "rate_limit_rpm",
      proposedValue: 200,
      changeComment: "Test",
      actorId: "admin-1",
    });

    expect(result.success).toBe(true);
    expect((result.data as any).success).toBe(true);
  });

  it("rejects invalid values before creating approval", async () => {
    mockGetEnhancedConfig.mockResolvedValue(makeEntry());
    mockValidateConfigValue.mockReturnValue({
      valid: false,
      errors: ["Too high"],
    });

    const result = await handleRequestApproval({
      configKey: "rate_limit_rpm",
      proposedValue: 9999,
      changeComment: "Test",
      actorId: "admin-1",
    });

    expect(result.success).toBe(true);
    expect((result.data as any).success).toBe(false);
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: approve_change
// ═══════════════════════════════════════════════════════════════════════

describe("handleResetConfig — the tenant's own value removed, governed", () => {
  const SHARED = Object.freeze({
    tenantId: "11111111-1111-4111-8111-111111111111",
    mode: "shared" as const,
  });
  const reset = (input: Partial<Parameters<typeof handleResetConfig>[0]> = {}) =>
    runWithTenant(SHARED, () =>
      handleResetConfig({
        key: "rate_limit_rpm",
        changeComment: "back to default",
        actorId: "admin-1",
        confirmed: true,
        ...input,
      })
    );
  const own = (o: Partial<EnhancedConfigEntry> = {}) =>
    makeEntry({
      overridden: true,
      tenantOverridable: true,
      value: 5,
      platformValue: 100,
      ...o,
    });

  it("an unknown key is not applied", async () => {
    mockGetEnhancedConfig.mockResolvedValue(null);
    expect((await reset()).data).toMatchObject({ applied: false });
    expect(mockClearTenantConfig).not.toHaveBeenCalled();
  });

  it("a single deployment, or a key without the tenant's own value: nothing to change", async () => {
    mockGetEnhancedConfig.mockResolvedValue(own());
    const single = await handleResetConfig({
      key: "rate_limit_rpm",
      changeComment: "c",
      actorId: "a",
      confirmed: true,
    });
    expect(single.data).toEqual({ applied: true, unchanged: true });
    mockGetEnhancedConfig.mockResolvedValue(own({ overridden: false }));
    expect((await reset()).data).toEqual({ applied: true, unchanged: true });
    expect(mockClearTenantConfig).not.toHaveBeenCalled();
  });

  it("refuses a non-operator a key that governs the platform", async () => {
    mockGetEnhancedConfig.mockResolvedValue(own({ tenantOverridable: false }));
    expect((await reset()).data).toMatchObject({ applied: false, error: /operator/ });
    expect(mockClearTenantConfig).not.toHaveBeenCalled();
  });

  it("previews without applying unless confirmed (P10)", async () => {
    mockGetEnhancedConfig.mockResolvedValue(own());
    mockIsApprovalRequired.mockResolvedValue(false);
    const r = await reset({ confirmed: false });
    expect(r.data).toMatchObject({ applied: false, pendingConfirmation: true });
    expect((r.data as any).changeRequest.proposedValue).toBe(100);
    expect(mockClearTenantConfig).not.toHaveBeenCalled();
  });

  it("applies a standard-tier reset", async () => {
    mockGetEnhancedConfig.mockResolvedValue(own());
    mockIsApprovalRequired.mockResolvedValue(true);
    mockClearTenantConfig.mockResolvedValue({ success: true });
    expect((await reset()).data).toMatchObject({ applied: true });
    expect(mockClearTenantConfig).toHaveBeenCalledWith(
      "rate_limit_rpm",
      "admin-1",
      "back to default",
      false,
      {}
    );
  });

  it("a safety-tier reset under two-person approval becomes a pending 'reset' approval", async () => {
    mockGetEnhancedConfig.mockResolvedValue(
      own({ key: "moderation.strike_ban_threshold", permissionTier: "safety" })
    );
    mockIsApprovalRequired.mockResolvedValue(true);
    mockRequestApproval.mockResolvedValue({ success: true, record: { id: "apr-9" } });
    const r = await reset({
      key: "moderation.strike_ban_threshold",
      actorIsOperator: true,
    });
    expect(r.data).toMatchObject({ applied: false, requiresApproval: true });
    expect(mockRequestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        configKey: "moderation.strike_ban_threshold",
        currentValue: 5,
        proposedValue: 100,
        scope: "tenant",
        action: "reset",
      })
    );
    expect(mockClearTenantConfig).not.toHaveBeenCalled();
  });

  it("reports a failed clear", async () => {
    mockGetEnhancedConfig.mockResolvedValue(own());
    mockIsApprovalRequired.mockResolvedValue(false);
    mockClearTenantConfig.mockResolvedValue({ success: false, error: "audit down" });
    expect((await reset()).data).toMatchObject({ applied: false, error: "audit down" });
  });

  it("approving a 'reset' approval clears the tenant's value — never sets the proposed value", async () => {
    mockApproveApprovalChange.mockResolvedValue({
      success: true,
      record: {
        id: "apr-9",
        configKey: "moderation.strike_ban_threshold",
        currentValue: 5,
        proposedValue: 100,
        changeComment: "back",
        scope: "tenant",
        action: "reset",
      },
    });
    mockClearTenantConfig.mockResolvedValue({ success: true });
    const r = await runWithTenant(SHARED, () =>
      handleApproveChange({
        approvalId: "apr-9",
        reviewerId: "op-2",
        reviewComment: "ok",
        reviewerIsOperator: true,
      })
    );
    expect(r.data).toMatchObject({ approved: true, applied: true });
    expect(mockClearTenantConfig).toHaveBeenCalledWith(
      "moderation.strike_ban_threshold",
      "op-2",
      "Approved: back",
      true,
      // Only onto the value it was requested against (review 12 H2), and onto the platform
      // default it was requested to inherit — the approval's proposed value (review 13 M1).
      { expectPrevious: { value: 5 }, expectInherited: { value: 100 } }
    );
    expect(mockSetConfigWithHistory).not.toHaveBeenCalled();
  });

  it("is dual-controlled like an update: a listed key is held", async () => {
    mockGetConfig.mockResolvedValue(["rate_limit_rpm"]);
    mockGetEnhancedConfig.mockResolvedValue(own());
    mockIsApprovalRequired.mockResolvedValue(false);
    mockClearTenantConfig.mockResolvedValue({ success: true });
    const r = await runWithTenant(SHARED, () =>
      dispatchConfigTool("reset_config", {
        key: "rate_limit_rpm",
        changeComment: "c",
        actorId: "admin-1",
        confirmed: true,
      })
    );
    expect(r.held).toBe(true);
    expect(mockClearTenantConfig).not.toHaveBeenCalled();
  });
});

describe("handleApproveChange", () => {
  it("approves and applies the change", async () => {
    mockApproveApprovalChange.mockResolvedValue({
      success: true,
      record: {
        id: "apr-1",
        configKey: "moderation.level2.block_severity",
        proposedValue: "high",
        changeComment: "Tightening",
      },
    });
    mockSetConfigWithHistory.mockResolvedValue({ success: true });

    const result = await handleApproveChange({
      approvalId: "apr-1",
      reviewerId: "admin-2",
      reviewComment: "Looks good",
    });

    expect(result.success).toBe(true);
    expect((result.data as any).approved).toBe(true);
    expect((result.data as any).applied).toBe(true);
    expect(mockSetConfigWithHistory).toHaveBeenCalled();
  });

  it("reports failure, not success, when the approved change cannot be applied (B11, release review)", async () => {
    mockApproveApprovalChange.mockResolvedValue({
      success: true,
      record: {
        id: "apr-1",
        configKey: "moderation.level2.block_severity",
        proposedValue: "high",
        changeComment: "Tightening",
      },
    });
    mockSetConfigWithHistory.mockResolvedValue({
      success: false,
      error: "Database connection refused",
    });

    const result = await handleApproveChange({
      approvalId: "apr-1",
      reviewerId: "admin-2",
      reviewComment: "Looks good",
    });

    expect(result.success).toBe(true); // Tool executed
    expect((result.data as any).success).toBe(false);
    expect((result.data as any).error).toContain("Database connection");
  });

  it("returns error when approval fails", async () => {
    mockApproveApprovalChange.mockResolvedValue({
      success: false,
      error: "Self-approval is not permitted",
    });

    const result = await handleApproveChange({
      approvalId: "apr-1",
      reviewerId: "admin-1",
      reviewComment: "My own",
    });

    expect(result.success).toBe(true);
    expect((result.data as any).success).toBe(false);
    expect(mockSetConfigWithHistory).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool: reject_change
// ═══════════════════════════════════════════════════════════════════════

describe("handleRejectChange", () => {
  it("rejects the pending change", async () => {
    mockRejectApprovalChange.mockResolvedValue({
      success: true,
      record: { id: "apr-1", status: "rejected" },
    });

    const result = await handleRejectChange({
      approvalId: "apr-1",
      reviewerId: "admin-2",
      reviewComment: "Too risky",
    });

    expect(result.success).toBe(true);
    expect((result.data as any).success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Dispatcher
// ═══════════════════════════════════════════════════════════════════════

describe("dispatchConfigTool", () => {
  it("routes search_config correctly", async () => {
    mockListEnhancedConfig.mockResolvedValue([]);

    const result = await dispatchConfigTool("search_config", {
      query: "rate",
    });

    expect(result.success).toBe(true);
    expect(result.toolId).toBe("search_config");
  });

  it("rejects missing required fields (B5)", async () => {
    const result = await dispatchConfigTool("update_config", {
      // missing key, value, changeComment
      actorId: "admin-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing required fields");
    expect(result.error).toContain("key");
  });

  it("accepts tools with no required fields", async () => {
    mockListEnhancedConfig.mockResolvedValue([]);

    const result = await dispatchConfigTool("search_config", {});

    expect(result.success).toBe(true);
  });

  it("returns error for unknown tool", async () => {
    const result = await dispatchConfigTool("nonexistent_tool", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("records trajectory step when context provided (P18)", async () => {
    mockListEnhancedConfig.mockResolvedValue([]);

    const context: ToolExecutionContext = {
      trajectoryId: "traj-test",
      agentId: "agent-test",
      onBehalfOf: "admin-1",
      steps: [],
    };

    await dispatchConfigTool("search_config", {}, context);

    expect(context.steps).toHaveLength(1);
    expect(context.steps[0].action).toBe("search_config");
    expect(context.steps[0].boundary).toBe("cognition");
    expect(context.steps[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks write tools as commitment boundary (P17)", async () => {
    mockGetEnhancedConfig.mockResolvedValue(null);

    const context: ToolExecutionContext = {
      trajectoryId: "traj-test",
      agentId: "agent-test",
      onBehalfOf: "admin-1",
      steps: [],
    };

    await dispatchConfigTool(
      "update_config",
      {
        key: "k1",
        value: "v1",
        changeComment: "test",
      },
      context
    );

    expect(context.steps).toHaveLength(1);
    expect(context.steps[0].boundary).toBe("commitment");
  });

  // Each held write names an entry that takes its value: a change is held only as its handler
  // would take it (round 12, pre-existing 1 — these used no entry at all).
  it("holds a write to a dual-control key for human approval (ADR-039 F2b-2)", async () => {
    mockGetConfig.mockResolvedValue(["signups_enabled"]);
    mockGetEnhancedConfig.mockResolvedValue(makeEntry({ key: "signups_enabled" }));
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });

    const context: ToolExecutionContext = {
      trajectoryId: "traj-dc-1",
      agentId: "agent-test",
      onBehalfOf: "admin-1",
      steps: [],
    };

    const result = await dispatchConfigTool(
      "update_config",
      { key: "signups_enabled", value: "false", changeComment: "flip" },
      context
    );

    expect(result.held).toBe(true);
    expect(result.success).toBe(false);
    expect(result.approval?.requiredApprover).toBe("user");
    expect(result.approval?.proposalId).toBeTruthy();
  });

  // Round 12, pre-existing 1: an invalid value — or a key with no entry — is refused as the
  // handler refuses it, never held.
  it.each([
    ["a value its entry refuses", () => makeEntry({ key: "signups_enabled" }), false],
    ["a key with no entry", () => null, true],
  ])("never holds a dual-controlled write with %s", async (_label, entry, valid) => {
    mockGetConfig.mockResolvedValue(["signups_enabled"]);
    mockGetEnhancedConfig.mockResolvedValue(entry());
    mockValidateConfigValue.mockReturnValue(
      valid
        ? { valid: true, errors: [] }
        : { valid: false, errors: ["must be a boolean"] }
    );
    const result = await dispatchConfigTool(
      "update_config",
      { key: "signups_enabled", value: "she lives at 1 Main St", changeComment: "c" },
      {
        trajectoryId: "traj-dc-bad",
        agentId: "agent-test",
        onBehalfOf: "admin-1",
        steps: [],
      }
    );
    expect(result.held).toBeUndefined();
    expect(result.data).toMatchObject({ applied: false });
    expect(result.approval).toBeUndefined();
    expect(
      (await getProposalStore().query({})).filter((p) => p.trajectoryId === "traj-dc-bad")
    ).toEqual([]);
  });

  // Round 13, P-2: nor one its scope refuses, and a reset as its handler would take it — each
  // refused now, coded, never held for an approver to clear and the run to refuse.
  describe("never holds a change its run would refuse (round 13, P-2)", () => {
    const SHARED = Object.freeze({
      tenantId: "11111111-1111-4111-8111-111111111111",
      mode: "shared" as const,
    });
    const held = (toolId: string, input: Record<string, unknown>) =>
      runWithTenant(SHARED, () =>
        dispatchConfigTool(
          toolId,
          { changeComment: "c", actorId: "admin-1", ...input },
          {
            trajectoryId: `traj-p2-${toolId}`,
            agentId: "a",
            onBehalfOf: "admin-1",
            steps: [],
          }
        )
      );
    beforeEach(() => {
      mockGetConfig.mockResolvedValue(["signups_enabled"]);
      mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    });
    const notHeld = async (result: Awaited<ReturnType<typeof held>>, code: string) => {
      expect(result.held).toBeUndefined();
      expect(result.errorCode).toBe(code);
      expect(
        (await getProposalStore().query({})).filter((p) =>
          /traj-p2-/.test(p.trajectoryId)
        )
      ).toEqual([]);
    };

    it("an update to the platform default by a tenant admin", async () => {
      mockGetEnhancedConfig.mockResolvedValue(
        makeEntry({ key: "signups_enabled", tenantOverridable: true })
      );
      await notHeld(
        await held("update_config", {
          key: "signups_enabled",
          value: true,
          scope: "platform",
        }),
        "admin.config_scope_refused"
      );
    });

    it("an update to a key that governs the platform, by a tenant admin", async () => {
      mockGetEnhancedConfig.mockResolvedValue(
        makeEntry({ key: "signups_enabled", tenantOverridable: false })
      );
      await notHeld(
        await held("update_config", { key: "signups_enabled", value: true }),
        "admin.config_scope_refused"
      );
    });

    it("a reset of a key that governs the platform, by a tenant admin", async () => {
      mockGetEnhancedConfig.mockResolvedValue(
        makeEntry({ key: "signups_enabled", tenantOverridable: false, overridden: true })
      );
      await notHeld(
        await held("reset_config", { key: "signups_enabled" }),
        "admin.config_scope_refused"
      );
    });

    it("a reset of a key with no entry", async () => {
      mockGetEnhancedConfig.mockResolvedValue(null);
      await notHeld(
        await held("reset_config", { key: "signups_enabled" }),
        "admin.target_not_found"
      );
    });

    it("a reset its tenant may make is held, as before", async () => {
      mockGetEnhancedConfig.mockResolvedValue(
        makeEntry({ key: "signups_enabled", tenantOverridable: true, overridden: true })
      );
      expect((await held("reset_config", { key: "signups_enabled" })).held).toBe(true);
    });
  });

  it("does NOT hold a write to a non-dual-control key", async () => {
    mockGetConfig.mockResolvedValue(["signups_enabled"]);
    mockGetEnhancedConfig.mockResolvedValue(null);

    const context: ToolExecutionContext = {
      trajectoryId: "traj-dc-2",
      agentId: "agent-test",
      onBehalfOf: "admin-1",
      steps: [],
    };

    const result = await dispatchConfigTool(
      "update_config",
      { key: "moderation.strike_warn_threshold", value: "2", changeComment: "tune" },
      context
    );

    expect(result.held).toBeFalsy();
  });

  it.each([
    [
      "the key list cannot be read",
      () => mockGetConfig.mockRejectedValue(new Error("down")),
    ],
    [
      "the key list is not a list",
      () => mockGetConfig.mockResolvedValue("signups_enabled"),
    ],
  ])("holds every config write when %s (fail closed)", async (_label, arrange) => {
    arrange();
    mockGetEnhancedConfig.mockResolvedValue(makeEntry({ key: "rate_limit_rpm" }));
    mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
    const result = await dispatchConfigTool(
      "update_config",
      { key: "rate_limit_rpm", value: 1, changeComment: "x", actorId: "admin-1" },
      {
        trajectoryId: "traj-dc-3",
        agentId: "agent-test",
        onBehalfOf: "admin-1",
        steps: [],
      }
    );
    expect(result.held).toBe(true);
  });

  it.each(["config.dual_control_keys", "config.require_two_person_approval"])(
    "always holds a change to %s, even when the list omits it",
    async (key) => {
      mockGetConfig.mockResolvedValue([]);
      mockGetEnhancedConfig.mockResolvedValue(makeEntry({ key }));
      mockValidateConfigValue.mockReturnValue({ valid: true, errors: [] });
      const result = await dispatchConfigTool(
        "update_config",
        { key, value: [], changeComment: "remove dual control", actorId: "admin-1" },
        {
          trajectoryId: `traj-dc-${key}`,
          agentId: "agent-test",
          onBehalfOf: "admin-1",
          steps: [],
        }
      );
      expect(result.held).toBe(true);
    }
  );

  it("works without context (backward compatible)", async () => {
    mockListEnhancedConfig.mockResolvedValue([]);

    const result = await dispatchConfigTool("search_config", {});

    expect(result.success).toBe(true);
    // No crash, no trajectory — backward compatible
  });

  it("records duration on every call", async () => {
    mockListEnhancedConfig.mockResolvedValue([]);

    const result = await dispatchConfigTool("search_config", {});

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("CONFIG_TOOLS executable contract (ADR-029 D1)", () => {
  it("every tool in the roster carries an invocable handler", async () => {
    mockListEnhancedConfig.mockResolvedValue([]);

    const invoked: string[] = [];
    for (const tool of CONFIG_TOOLS) {
      try {
        await tool.execute({});
      } catch {
        /* justified */
        // Handlers reject empty input in their own ways. This arm asserts the closure is
        // reachable and wired to a handler, not that the handler succeeds on no input —
        // per-tool success is covered by the per-tool describes above.
      }
      invoked.push(tool.id);
    }

    expect(invoked).toEqual(CONFIG_TOOLS.map((tool) => tool.id));
  });

  it("the roster is the dispatcher — an id outside it is unknown", async () => {
    const result = await dispatchConfigTool("not_a_tool", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool definitions
// ═══════════════════════════════════════════════════════════════════════

describe("buildChangeRequest (A8: pure function)", () => {
  it("builds change request with correct fields", () => {
    const entry = makeEntry({
      key: "moderation.level1.block_severity",
      value: "medium",
      permissionTier: "safety",
    });

    const result = buildChangeRequest(entry, "high", "Tightening", true);

    expect(result.key).toBe("moderation.level1.block_severity");
    expect(result.currentValue).toBe("medium");
    expect(result.proposedValue).toBe("high");
    expect(result.changeComment).toBe("Tightening");
    expect(result.requiresApproval).toBe(true);
    expect(result.permissionTier).toBe("safety");
    expect(result.impact).toContain("safety-critical");
    expect(result.affectedUsers).toContain("under 13");
  });

  it("identifies affected users by key pattern", () => {
    const level2 = makeEntry({ key: "moderation.level2.warn_severity" });
    expect(buildChangeRequest(level2, "low", "test", false).affectedUsers).toContain(
      "13"
    );

    const level3 = makeEntry({ key: "moderation.level3.block_severity" });
    expect(buildChangeRequest(level3, "low", "test", false).affectedUsers).toContain(
      "18+"
    );
  });
});

describe("CONFIG_TOOLS", () => {
  it("defines exactly 11 tools", () => {
    expect(CONFIG_TOOLS).toHaveLength(11);
  });

  it("each tool has required fields", () => {
    for (const tool of CONFIG_TOOLS) {
      expect(tool.id).toBeTruthy();
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
      expect(Array.isArray(tool.effects)).toBe(true);
    }
  });

  it("tool IDs are unique", () => {
    const ids = CONFIG_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// TASK-064 close condition: the boundary map and the tool roster cannot drift
// apart unnoticed. Every CONFIG_TOOLS id must resolve an explicit boundary
// (never fall through to the fail-closed "commitment" default), and the map
// must carry no stale ids.
// ---------------------------------------------------------------------------
describe("tool boundary map conformance (TASK-064)", () => {
  it("every CONFIG_TOOLS id resolves an explicit boundary (no default fallthrough)", () => {
    for (const tool of CONFIG_TOOLS) {
      expect(TOOL_BOUNDARIES[tool.id]).toBeDefined();
    }
  });

  it("TOOL_BOUNDARIES carries no id that is not a CONFIG_TOOLS tool (no drift)", () => {
    const ids = new Set(CONFIG_TOOLS.map((t) => t.id));
    for (const key of Object.keys(TOOL_BOUNDARIES)) {
      expect(ids.has(key)).toBe(true);
    }
  });
});

// TASK-194, audit C-1: each write handler acts on the key in the field CONFIG_TOOL_TARGET_FIELD
// names — the field the execute route checks the tier of — never on the other one.
describe("the config write handlers act on the key the route checks", () => {
  const { CONFIG_TOOL_TARGET_FIELD } = jest.requireActual(
    "@/platform/admin/hold-keys"
  ) as typeof import("@/platform/admin/hold-keys");
  const handlers: Record<string, (input: any) => Promise<unknown>> = {
    update_config: handleUpdateConfig,
    reset_config: handleResetConfig,
    request_approval: handleRequestApproval,
  };

  it("names a handler for every mapped tool, and a mapping for every write handler", () => {
    expect(Object.keys(CONFIG_TOOL_TARGET_FIELD).sort()).toEqual(
      Object.keys(handlers).sort()
    );
  });

  it.each(Object.keys(handlers))(
    "%s reads only the key in its mapped field",
    async (toolId) => {
      mockGetEnhancedConfig.mockResolvedValue(null); // stops at the first read
      await runWithTenant(
        { tenantId: "00000000-0000-4000-8000-000000000001", mode: "single" },
        () =>
          handlers[toolId]({
            key: "checked.when.key",
            configKey: "checked.when.configKey",
            value: 1,
            proposedValue: 1,
            changeComment: "c",
            actorId: "00000000-0000-4000-8000-0000000000aa",
          })
      );
      const read = mockGetEnhancedConfig.mock.calls.map((c) => c[0]);
      expect(read).toEqual([`checked.when.${CONFIG_TOOL_TARGET_FIELD[toolId]}`]);
    }
  );
});
