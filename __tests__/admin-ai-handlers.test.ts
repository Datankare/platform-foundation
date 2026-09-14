/**
 * __tests__/admin-ai-handlers.test.ts — coverage remediation (ADR-040 "B", B3b).
 *
 * The remaining ai command-bar handlers: agents, approval, config, entitlements,
 * mapping, restrictions, search. Success, validation, not-found, and store/db error
 * branches for each.
 */
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/platform/auth/audit", () => ({ writeAuditLog: jest.fn() }));
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(),
  setConfig: jest.fn(),
}));
jest.mock("@/platform/agents", () => ({ getApprovalPolicyStore: jest.fn() }));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { getConfig, setConfig } from "@/platform/auth/platform-config";
import { getApprovalPolicyStore } from "@/platform/agents";

import {
  handleRegisterAgent,
  handleSuspendAgent,
  handleSetAgentScope,
  handleSetAgentTtl,
} from "@/app/api/admin/ai/handlers/agents";
import { handleSetApprovalPolicy } from "@/app/api/admin/ai/handlers/approval";
import {
  handleUpdateGuestConfig,
  handleUpdatePasswordPolicy,
} from "@/app/api/admin/ai/handlers/config";
import { handleCreateEntitlementGroup } from "@/app/api/admin/ai/handlers/entitlements";
import { handleSetCapabilityMapping } from "@/app/api/admin/ai/handlers/mapping";
import {
  handleBlockUserFeature,
  handleUnblockUserFeature,
} from "@/app/api/admin/ai/handlers/restrictions";
import { handleSearch } from "@/app/api/admin/ai/handlers/search";

const mockSupabase = getSupabaseServiceClient as jest.Mock;
const mockGetConfig = getConfig as jest.Mock;
const mockSetConfig = setConfig as jest.Mock;
const mockPolicyStore = getApprovalPolicyStore as jest.Mock;

function makeSupabase(tableResults: Record<string, Record<string, unknown>>) {
  const from = jest.fn((table: string) => {
    const result = tableResults[table] ?? { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: Record<string, any> = {};
    const methods = [
      "select",
      "eq",
      "or",
      "is",
      "order",
      "update",
      "insert",
      "upsert",
      "delete",
      "single",
      "in",
      "limit",
    ];
    for (const m of methods) {
      builder[m] = jest.fn(() => builder);
    }
    builder.then = (resolve: (v: unknown) => void) => resolve(result);
    return builder;
  });
  return { from };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSetConfig.mockResolvedValue(undefined);
});

describe("agents handlers", () => {
  it("registers a new agent", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleRegisterAgent({ agent_id: "a1", scopes: ["x"] }, "admin-1");
    expect(res.success).toBe(true);
    expect(mockSetConfig).toHaveBeenCalled();
  });

  it("rejects a missing agent_id", async () => {
    const res = await handleRegisterAgent({}, "admin-1");
    expect(res.success).toBe(false);
  });

  it("rejects a duplicate registration", async () => {
    mockGetConfig.mockResolvedValue([
      ["a1", { owner: "o", scopes: [], status: "active" }],
    ]);
    const res = await handleRegisterAgent({ agent_id: "a1" }, "admin-1");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already registered/);
  });

  it("surfaces a setConfig failure", async () => {
    mockGetConfig.mockResolvedValue([]);
    mockSetConfig.mockRejectedValue(new Error("gate closed"));
    const res = await handleRegisterAgent({ agent_id: "a1" }, "admin-1");
    expect(res.success).toBe(false);
    expect(res.error).toBe("gate closed");
  });

  it("suspends and reactivates an agent", async () => {
    mockGetConfig.mockResolvedValue([
      ["a1", { owner: "o", scopes: [], status: "active" }],
    ]);
    const suspended = await handleSuspendAgent({ agent_id: "a1" }, "admin-1");
    expect(suspended.success).toBe(true);
    const reactivated = await handleSuspendAgent(
      { agent_id: "a1", reactivate: true },
      "admin-1"
    );
    expect(reactivated.success).toBe(true);
  });

  it("refuses to suspend an unknown agent", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSuspendAgent({ agent_id: "ghost" }, "admin-1");
    expect(res.success).toBe(false);
  });

  it("sets an agent scope", async () => {
    mockGetConfig.mockResolvedValue([
      ["a1", { owner: "o", scopes: [], status: "active" }],
    ]);
    const res = await handleSetAgentScope(
      { agent_id: "a1", scopes: ["read"] },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("refuses a scope change for an unknown agent", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetAgentScope({ agent_id: "ghost", scopes: [] }, "admin-1");
    expect(res.success).toBe(false);
  });

  it("sets a token ttl and rejects invalid values", async () => {
    mockGetConfig.mockResolvedValue([
      ["a1", { owner: "o", scopes: [], status: "active" }],
    ]);
    const ok = await handleSetAgentTtl({ agent_id: "a1", max_token_ttl: 600 }, "admin-1");
    expect(ok.success).toBe(true);
    const bad = await handleSetAgentTtl({ agent_id: "a1", max_token_ttl: -1 }, "admin-1");
    expect(bad.success).toBe(false);
  });

  it("refuses a ttl change for an unknown agent", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetAgentTtl(
      { agent_id: "ghost", max_token_ttl: 300 },
      "admin-1"
    );
    expect(res.success).toBe(false);
  });
});

describe("approval handler", () => {
  it("sets the approval policy", async () => {
    mockPolicyStore.mockReturnValue({
      setRules: jest.fn().mockResolvedValue({ version: 2 }),
    });
    const res = await handleSetApprovalPolicy(
      {
        rules: [
          { max_risk: "restricted", effects: ["stateWrite"], required_approver: "user" },
        ],
      },
      "admin-1"
    );
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/version 2/);
  });

  it("surfaces a store failure", async () => {
    mockPolicyStore.mockReturnValue({
      setRules: jest.fn().mockRejectedValue(new Error("nope")),
    });
    const res = await handleSetApprovalPolicy({ rules: [] }, "admin-1");
    expect(res.success).toBe(false);
  });
});

describe("config handlers", () => {
  it("updates guest config", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ guest_config: { error: null } }));
    const res = await handleUpdateGuestConfig({ nudge_after_sessions: 2 }, "admin-1");
    expect(res.success).toBe(true);
  });

  it("surfaces a guest-config insert error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ guest_config: { error: { message: "boom" } } })
    );
    const res = await handleUpdateGuestConfig({}, "admin-1");
    expect(res.success).toBe(false);
  });

  it("updates the password policy", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ password_policy: { error: null } }));
    const res = await handleUpdatePasswordPolicy({ min_length: 14 }, "admin-1");
    expect(res.success).toBe(true);
  });

  it("surfaces a password-policy upsert error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ password_policy: { error: { message: "no" } } })
    );
    const res = await handleUpdatePasswordPolicy({}, "admin-1");
    expect(res.success).toBe(false);
  });
});

describe("entitlements handler", () => {
  it("creates a group with permissions", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        entitlement_groups: { data: { id: "g1" }, error: null },
        permissions: { data: [{ id: "p1" }] },
        entitlement_permissions: { data: null },
      })
    );
    const res = await handleCreateEntitlementGroup(
      { code: "pro", display_name: "Pro", permissions: ["can_x"] },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("surfaces an insert error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ entitlement_groups: { data: null, error: { message: "dup" } } })
    );
    const res = await handleCreateEntitlementGroup(
      { code: "pro", display_name: "Pro" },
      "admin-1"
    );
    expect(res.success).toBe(false);
  });
});

describe("mapping handler", () => {
  it("adds a new capability mapping", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetCapabilityMapping(
      { capability: "cap", features: ["f1"] },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("replaces an existing mapping", async () => {
    mockGetConfig.mockResolvedValue([["cap", ["old"]]]);
    const res = await handleSetCapabilityMapping(
      { capability: "cap", features: ["new"] },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("removes a mapping", async () => {
    mockGetConfig.mockResolvedValue([["cap", ["f1"]]]);
    const res = await handleSetCapabilityMapping(
      { capability: "cap", remove: true },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("rejects a missing capability", async () => {
    const res = await handleSetCapabilityMapping({ features: ["f1"] }, "admin-1");
    expect(res.success).toBe(false);
  });

  it("rejects removing an unknown mapping", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetCapabilityMapping(
      { capability: "ghost", remove: true },
      "admin-1"
    );
    expect(res.success).toBe(false);
  });

  it("rejects an empty feature list", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetCapabilityMapping(
      { capability: "cap", features: [] },
      "admin-1"
    );
    expect(res.success).toBe(false);
  });

  it("surfaces a setConfig failure", async () => {
    mockGetConfig.mockResolvedValue([]);
    mockSetConfig.mockRejectedValue(new Error("gate"));
    const res = await handleSetCapabilityMapping(
      { capability: "cap", features: ["f1"] },
      "admin-1"
    );
    expect(res.success).toBe(false);
  });
});

describe("restrictions handlers", () => {
  it("blocks a feature for a user", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ user_feature_restrictions: { error: null } })
    );
    const res = await handleBlockUserFeature(
      { user_id: "u1", feature: "chat" },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("rejects a block with missing fields", async () => {
    const res = await handleBlockUserFeature({ user_id: "u1" }, "admin-1");
    expect(res.success).toBe(false);
  });

  it("surfaces a block error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ user_feature_restrictions: { error: { message: "no" } } })
    );
    const res = await handleBlockUserFeature(
      { user_id: "u1", feature: "chat" },
      "admin-1"
    );
    expect(res.success).toBe(false);
  });

  it("unblocks a feature", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ user_feature_restrictions: { error: null } })
    );
    const res = await handleUnblockUserFeature(
      { user_id: "u1", feature: "chat" },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("rejects an unblock with missing fields", async () => {
    const res = await handleUnblockUserFeature({ feature: "chat" }, "admin-1");
    expect(res.success).toBe(false);
  });
});

describe("search handler", () => {
  it("returns rows for a table", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ users: { data: [{ id: "u1" }], error: null } })
    );
    const res = await handleSearch({ table: "users" });
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/u1/);
  });

  it("surfaces a query error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ users: { data: null, error: { message: "bad" } } })
    );
    const res = await handleSearch({ table: "users" });
    expect(res.success).toBe(false);
  });
});
