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

jest.mock("@/platform/auth/platform-config", () => ({
  getEnhancedConfig: (...args: any[]) => mockGetEnhancedConfig(...args),
  listEnhancedConfig: (...args: any[]) => mockListEnhancedConfig(...args),
  validateConfigValue: (...args: any[]) => mockValidateConfigValue(...args),
  setConfigWithHistory: (...args: any[]) => mockSetConfigWithHistory(...args),
  getConfigHistory: (...args: any[]) => mockGetConfigHistory(...args),
  getPermissionTier: (...args: any[]) => mockGetPermissionTier(...args),
}));

const mockIsApprovalRequired = jest.fn();
const mockRequestApproval = jest.fn();
const mockApproveApprovalChange = jest.fn();
const mockRejectApprovalChange = jest.fn();
const mockListApprovals = jest.fn();

jest.mock("../config-approval", () => ({
  isApprovalRequired: (...args: any[]) => mockIsApprovalRequired(...args),
  requestApproval: (...args: any[]) => mockRequestApproval(...args),
  approveChange: (...args: any[]) => mockApproveApprovalChange(...args),
  rejectChange: (...args: any[]) => mockRejectApprovalChange(...args),
  listApprovals: (...args: any[]) => mockListApprovals(...args),
}));

const mockGenerateImpactReport = jest.fn();
const mockIsModerationConfig = jest.fn();

jest.mock("../config-impact", () => ({
  generateImpactReport: (...args: any[]) => mockGenerateImpactReport(...args),
  isModerationConfig: (...args: any[]) => mockIsModerationConfig(...args),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import {
  handleSearchConfig,
  handleGetConfig,
  handleUpdateConfig,
  handleGetHistory,
  handleCompareToDefaults,
  handleImpactReport,
  handleBulkReview,
  handleRequestApproval,
  handleApproveChange,
  handleRejectChange,
  dispatchConfigTool,
  CONFIG_TOOLS,
} from "../config-handlers";
import type { EnhancedConfigEntry } from "../types";

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
    ...overrides,
  };
}

// ── Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
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

describe("handleUpdateConfig", () => {
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
    });

    expect(result.success).toBe(true);
    expect((result.data as any).applied).toBe(true);
    expect(mockSetConfigWithHistory).toHaveBeenCalledWith(
      "rate_limit_rpm",
      200,
      "admin-1",
      "Increasing for load test",
      "config_agent"
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

  it("returns error for unknown tool", async () => {
    const result = await dispatchConfigTool("nonexistent_tool", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("records duration on every call", async () => {
    mockListEnhancedConfig.mockResolvedValue([]);

    const result = await dispatchConfigTool("search_config", {});

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tool definitions
// ═══════════════════════════════════════════════════════════════════════

describe("CONFIG_TOOLS", () => {
  it("defines exactly 10 tools", () => {
    expect(CONFIG_TOOLS).toHaveLength(10);
  });

  it("each tool has required fields", () => {
    for (const tool of CONFIG_TOOLS) {
      expect(tool.id).toBeTruthy();
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("tool IDs are unique", () => {
    const ids = CONFIG_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
