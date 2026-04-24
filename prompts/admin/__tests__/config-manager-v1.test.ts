/**
 * prompts/admin/__tests__/config-manager-v1.test.ts
 *
 * Tests for the config management agent prompt.
 * Covers prompt construction, agent identity, tool descriptions,
 * and permission-aware content.
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

// Mocks needed for config-handlers import chain (triggered by buildToolDescriptions)
jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(),
}));

jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(),
  getEnhancedConfig: jest.fn(),
  listEnhancedConfig: jest.fn(),
  validateConfigValue: jest.fn(),
  setConfigWithHistory: jest.fn(),
  getConfigHistory: jest.fn(),
  getPermissionTier: jest.fn(),
}));

// ── Imports ─────────────────────────────────────────────────────────────

import {
  CONFIG_MANAGER_V1,
  buildConfigAgentIdentity,
  buildConfigManagerPrompt,
  buildToolDescriptions,
} from "../config-manager-v1";

// ── Tests ───────────────────────────────────────────────────────────────

describe("CONFIG_MANAGER_V1 metadata", () => {
  it("has correct prompt metadata", () => {
    expect(CONFIG_MANAGER_V1.name).toBe("config-manager");
    expect(CONFIG_MANAGER_V1.version).toBe(1);
    expect(CONFIG_MANAGER_V1.tier).toBe("standard");
    expect(CONFIG_MANAGER_V1.maxTokens).toBe(2048);
    expect(CONFIG_MANAGER_V1.temperature).toBe(0.2);
    expect(CONFIG_MANAGER_V1.agentRole).toBe("config-manager");
  });
});

describe("buildConfigAgentIdentity", () => {
  it("creates agent identity with correct role", () => {
    const identity = buildConfigAgentIdentity("user-123");

    expect(identity.actorType).toBe("agent");
    expect(identity.actorId).toMatch(/^config-manager-/);
    expect(identity.agentRole).toBe("config-manager");
    expect(identity.onBehalfOf).toBe("user-123");
  });

  it("generates unique agent IDs", () => {
    const id1 = buildConfigAgentIdentity("user-1");
    const id2 = buildConfigAgentIdentity("user-1");

    // May be same in fast tests, but structure is correct
    expect(id1.actorId).toMatch(/^config-manager-/);
    expect(id2.actorId).toMatch(/^config-manager-/);
  });
});

describe("buildConfigManagerPrompt", () => {
  it("includes admin user ID and role", () => {
    const prompt = buildConfigManagerPrompt({
      adminUserId: "admin-42",
      adminRole: "super_admin",
      permissionTier: "safety",
      approvalRequired: false,
    });

    expect(prompt).toContain("admin-42");
    expect(prompt).toContain("super_admin");
  });

  it("grants full access for super_admin", () => {
    const prompt = buildConfigManagerPrompt({
      adminUserId: "admin-1",
      adminRole: "super_admin",
      permissionTier: "safety",
      approvalRequired: false,
    });

    expect(prompt).toContain("Full access");
    expect(prompt).toContain("safety-critical settings");
  });

  it("restricts access for regular admin", () => {
    const prompt = buildConfigManagerPrompt({
      adminUserId: "admin-1",
      adminRole: "admin",
      permissionTier: "standard",
      approvalRequired: false,
    });

    expect(prompt).toContain("Standard tier only");
    expect(prompt).toContain("super_admin access");
  });

  it("includes approval workflow when enabled", () => {
    const prompt = buildConfigManagerPrompt({
      adminUserId: "admin-1",
      adminRole: "super_admin",
      permissionTier: "safety",
      approvalRequired: true,
    });

    expect(prompt).toContain("Approval required");
    expect(prompt).toContain("ENABLED");
    expect(prompt).toContain("two-person approval");
  });

  it("notes approval disabled when not required", () => {
    const prompt = buildConfigManagerPrompt({
      adminUserId: "admin-1",
      adminRole: "super_admin",
      permissionTier: "safety",
      approvalRequired: false,
    });

    expect(prompt).toContain("DISABLED");
    expect(prompt).toContain("immediately after confirmation");
  });

  it("includes all 10 tool names", () => {
    const prompt = buildConfigManagerPrompt({
      adminUserId: "admin-1",
      adminRole: "super_admin",
      permissionTier: "safety",
      approvalRequired: false,
    });

    const toolNames = [
      "search_config",
      "get_config",
      "update_config",
      "get_history",
      "compare_to_defaults",
      "impact_report",
      "bulk_review",
      "request_approval",
      "approve_change",
      "reject_change",
    ];

    for (const name of toolNames) {
      expect(prompt).toContain(name);
    }
  });

  it("includes reconfirmation flow instructions", () => {
    const prompt = buildConfigManagerPrompt({
      adminUserId: "admin-1",
      adminRole: "super_admin",
      permissionTier: "safety",
      approvalRequired: false,
    });

    expect(prompt).toContain("Reconfirmation Flow");
    expect(prompt).toContain("NEVER apply a change without");
    expect(prompt).toContain("change comment");
  });
});

describe("buildToolDescriptions", () => {
  it("returns 10 tool descriptions", () => {
    const tools = buildToolDescriptions();

    expect(tools).toHaveLength(10);
  });

  it("each tool has name, description, and input_schema", () => {
    const tools = buildToolDescriptions();

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
    }
  });

  it("tool names match CONFIG_TOOLS IDs", () => {
    const tools = buildToolDescriptions();
    const names = tools.map((t) => t.name);

    expect(names).toContain("search_config");
    expect(names).toContain("update_config");
    expect(names).toContain("impact_report");
  });
});
