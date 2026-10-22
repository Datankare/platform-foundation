/**
 * __tests__/admin-ai-handlers.test.ts — coverage remediation (ADR-040 "B", B3b).
 *
 * The remaining ai command-bar handlers: agents, approval, config, entitlements,
 * mapping, restrictions, search. Success, validation, not-found, and store/db error
 * branches for each.
 */
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(),
}));
jest.mock("@/platform/admin/governed-config", () => ({
  ...jest.requireActual("@/platform/admin/governed-config"),
  writeGovernedConfig: jest.fn(),
}));
jest.mock("@/platform/agents", () => ({
  ...jest.requireActual("@/platform/agents"),
  getApprovalPolicyStore: jest.fn(),
}));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { getConfig } from "@/platform/auth/platform-config";
import { writeGovernedConfig } from "@/platform/admin/governed-config";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { FakeDatabase } from "./helpers/fake-database";
import { getApprovalPolicyStore } from "@/platform/agents";

import {
  handleRegisterAgent,
  handleSuspendAgent,
  handleSetAgentScope,
  handleSetAgentTtl,
} from "@/app/api/admin/ai/handlers/agents";
import { handleSetApprovalPolicy } from "@/app/api/admin/ai/handlers/approval";
import { handleUpdatePasswordPolicy } from "@/app/api/admin/ai/handlers/config";
import { handleCreateEntitlementGroup } from "@/app/api/admin/ai/handlers/entitlements";
import { handleSetCapabilityMapping } from "@/app/api/admin/ai/handlers/mapping";
import {
  handleBlockUserFeature,
  handleUnblockUserFeature,
} from "@/app/api/admin/ai/handlers/restrictions";
import { handleSearch } from "@/app/api/admin/ai/handlers/search";

const mockSupabase = getSupabaseServiceClient as jest.Mock;
const mockGetConfig = getConfig as jest.Mock;
const mockWrite = writeGovernedConfig as jest.Mock;

/** Holds every permission these handlers check, except can_secret. */
const admin: VerifiedAdmin = {
  userId: "00000000-0000-4000-8000-00000000a001",
  sub: "sub-admin",
  roleName: "admin",
  permissions: ["admin_manage_users", "admin_manage_entitlements", "can_x"],
};
const failed = (error: string) => ({
  kind: "failed",
  result: { toolId: "update_config", success: false, data: null, error, durationMs: 0 },
});
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
  mockWrite.mockResolvedValue({ kind: "applied", result: {} });
  // Audit records go to a database that accepts them unless a test says otherwise.
  mockSupabase.mockReturnValue(makeSupabase({}));
});

describe("agents handlers", () => {
  it("registers a new agent", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleRegisterAgent({ agent_id: "a1", scopes: ["x"] }, admin);
    expect(res.success).toBe(true);
    expect(mockWrite).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ key: "agent.trusted_agents" })
    );
  });

  it("rejects a missing agent_id", async () => {
    const res = await handleRegisterAgent({}, admin);
    expect(res.success).toBe(false);
  });

  it("rejects a duplicate registration", async () => {
    mockGetConfig.mockResolvedValue([
      ["a1", { owner: "o", scopes: [], status: "active" }],
    ]);
    const res = await handleRegisterAgent({ agent_id: "a1" }, admin);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already registered/);
  });

  it("surfaces a governed-write failure", async () => {
    mockGetConfig.mockResolvedValue([]);
    mockWrite.mockResolvedValue(failed("gate closed"));
    const res = await handleRegisterAgent({ agent_id: "a1" }, admin);
    expect(res.success).toBe(false);
    expect(res.error).toBe("gate closed");
  });

  it("suspends and reactivates an agent", async () => {
    mockGetConfig.mockResolvedValue([
      ["a1", { owner: "o", scopes: [], status: "active" }],
    ]);
    const suspended = await handleSuspendAgent({ agent_id: "a1" }, admin);
    expect(suspended.success).toBe(true);
    const reactivated = await handleSuspendAgent(
      { agent_id: "a1", reactivate: true },
      admin
    );
    expect(reactivated.success).toBe(true);
  });

  it("refuses to suspend an unknown agent", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSuspendAgent({ agent_id: "ghost" }, admin);
    expect(res.success).toBe(false);
  });

  it("sets an agent scope", async () => {
    mockGetConfig.mockResolvedValue([
      ["a1", { owner: "o", scopes: [], status: "active" }],
    ]);
    const res = await handleSetAgentScope({ agent_id: "a1", scopes: ["read"] }, admin);
    expect(res.success).toBe(true);
  });

  it("refuses a scope change for an unknown agent", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetAgentScope({ agent_id: "ghost", scopes: [] }, admin);
    expect(res.success).toBe(false);
  });

  it("sets a token ttl and rejects invalid values", async () => {
    mockGetConfig.mockResolvedValue([
      ["a1", { owner: "o", scopes: [], status: "active" }],
    ]);
    const ok = await handleSetAgentTtl({ agent_id: "a1", max_token_ttl: 600 }, admin);
    expect(ok.success).toBe(true);
    const bad = await handleSetAgentTtl({ agent_id: "a1", max_token_ttl: -1 }, admin);
    expect(bad.success).toBe(false);
  });

  it("refuses a ttl change for an unknown agent", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetAgentTtl({ agent_id: "ghost", max_token_ttl: 300 }, admin);
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
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/version 2/);
  });

  it("surfaces a store failure", async () => {
    mockPolicyStore.mockReturnValue({
      setRules: jest.fn().mockRejectedValue(new Error("nope")),
    });
    const res = await handleSetApprovalPolicy(
      { rules: [] },
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(false);
  });
});

describe("config handlers (password policy)", () => {
  const withPolicy = (rows: Record<string, unknown>[]) => {
    const db = new FakeDatabase({ password_policy: rows });
    mockSupabase.mockReturnValue(db.client());
    return db;
  };

  it("creates the global policy when none exists, changing only the fields sent", async () => {
    const db = withPolicy([]);
    const res = await handleUpdatePasswordPolicy(
      { min_length: 14 },
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(true);
    expect(db.rows("password_policy")).toHaveLength(1);
    expect(db.rows("password_policy")[0]).toMatchObject({
      role_id: null,
      user_id: null,
      min_length: 14,
      rotation_days: 90,
    });
  });

  it("updates the one global row rather than adding another", async () => {
    const db = withPolicy([
      { id: "g", role_id: null, user_id: null, min_length: 12, rotation_days: 90 },
      { id: "r", role_id: "role-1", user_id: null, min_length: 20, rotation_days: 30 },
    ]);
    const res = await handleUpdatePasswordPolicy(
      { rotation_days: 0 },
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(true);
    expect(db.rows("password_policy")).toHaveLength(2);
    expect(db.rows("password_policy").find((r) => r.id === "g")?.rotation_days).toBe(0);
    expect(db.rows("password_policy").find((r) => r.id === "r")?.min_length).toBe(20);
  });

  it.each([
    [{ min_length: 4 }, "minLength"],
    [{ min_length: 12.5 }, "minLength"],
    [{ min_length: "16" }, "minLength"],
    [{ rotation_days: -1 }, "rotationDays"],
    [{ password_history_count: 1000 }, "passwordHistoryCount"],
    [{ require_special: "no" }, "requireSpecial"],
    [{ min_lenght: 16 }, "min_lenght"],
  ])("refuses %p and writes nothing", async (input, field) => {
    const db = withPolicy([]);
    const res = await handleUpdatePasswordPolicy(
      input,
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res).toMatchObject({ success: false, code: "request.invalid_value" });
    expect(res.params?.field).toBe(field);
    expect(db.rows("password_policy")).toHaveLength(0);
  });
});

describe("entitlements handler", () => {
  it("creates a group with permissions", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        entitlement_groups: { data: { id: "g1" }, error: null },
        permissions: { data: [{ id: "00000000-0000-4000-8000-00000000b001" }] },
        entitlement_permissions: { data: null },
      })
    );
    const res = await handleCreateEntitlementGroup(
      { code: "pro", display_name: "Pro", permissions: ["can_x"] },
      admin
    );
    expect(res.success).toBe(true);
  });

  it("surfaces an insert error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ entitlement_groups: { data: null, error: { message: "dup" } } })
    );
    const res = await handleCreateEntitlementGroup(
      { code: "pro", display_name: "Pro" },
      admin
    );
    expect(res.success).toBe(false);
  });
});

describe("mapping handler", () => {
  it("adds a new capability mapping", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetCapabilityMapping(
      { capability: "cap", features: ["f1"] },
      admin
    );
    expect(res.success).toBe(true);
  });

  it("replaces an existing mapping", async () => {
    mockGetConfig.mockResolvedValue([["cap", ["old"]]]);
    const res = await handleSetCapabilityMapping(
      { capability: "cap", features: ["new"] },
      admin
    );
    expect(res.success).toBe(true);
  });

  it("removes a mapping", async () => {
    mockGetConfig.mockResolvedValue([["cap", ["f1"]]]);
    const res = await handleSetCapabilityMapping(
      { capability: "cap", remove: true },
      admin
    );
    expect(res.success).toBe(true);
  });

  it("rejects a missing capability", async () => {
    const res = await handleSetCapabilityMapping({ features: ["f1"] }, admin);
    expect(res.success).toBe(false);
  });

  it("rejects removing an unknown mapping", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetCapabilityMapping(
      { capability: "ghost", remove: true },
      admin
    );
    expect(res.success).toBe(false);
  });

  it("rejects an empty feature list", async () => {
    mockGetConfig.mockResolvedValue([]);
    const res = await handleSetCapabilityMapping(
      { capability: "cap", features: [] },
      admin
    );
    expect(res.success).toBe(false);
  });

  it("surfaces a governed-write failure", async () => {
    mockGetConfig.mockResolvedValue([]);
    mockWrite.mockResolvedValue(failed("gate"));
    const res = await handleSetCapabilityMapping(
      { capability: "cap", features: ["f1"] },
      admin
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
      { user_id: "00000000-0000-4000-8000-00000000b001", feature: "chat" },
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(true);
  });

  it("rejects a block with missing fields", async () => {
    const res = await handleBlockUserFeature(
      { user_id: "00000000-0000-4000-8000-00000000b001" },
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(false);
  });

  it("surfaces a block error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ user_feature_restrictions: { error: { message: "no" } } })
    );
    const res = await handleBlockUserFeature(
      { user_id: "00000000-0000-4000-8000-00000000b001", feature: "chat" },
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(false);
  });

  it("unblocks a feature", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ user_feature_restrictions: { error: null } })
    );
    const res = await handleUnblockUserFeature(
      { user_id: "00000000-0000-4000-8000-00000000b001", feature: "chat" },
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(true);
  });

  it("rejects an unblock with missing fields", async () => {
    const res = await handleUnblockUserFeature(
      { feature: "chat" },
      "00000000-0000-4000-8000-00000000a001"
    );
    expect(res.success).toBe(false);
  });
});

describe("search handler", () => {
  it("returns rows for a table", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        users: { data: [{ id: "00000000-0000-4000-8000-00000000b001" }], error: null },
      })
    );
    const res = await handleSearch({ table: "users" }, admin);
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/00000000-0000-4000-8000-00000000b001/);
  });

  it("surfaces a query error", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ users: { data: null, error: { message: "bad" } } })
    );
    const res = await handleSearch({ table: "users" }, admin);
    expect(res.success).toBe(false);
  });
});

describe("hostile cases", () => {
  it("search refuses a table outside the allowlist", async () => {
    const res = await handleSearch({ table: "user_feature_restrictions" }, admin);
    expect(res).toMatchObject({ success: false, code: "request.invalid_value" });
    expect(mockSupabase).not.toHaveBeenCalled();
  });

  it("search refuses an allowlisted table whose permission the admin lacks", async () => {
    const res = await handleSearch({ table: "audit_log" }, admin);
    expect(res).toMatchObject({
      success: false,
      code: "auth.permission_denied",
      params: { permission: "admin_view_audit" },
    });
    expect(mockSupabase).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "toString", "users; drop table users"])(
    "search refuses the crafted table name %p",
    async (table) => {
      const res = await handleSearch({ table }, admin);
      expect(res.success).toBe(false);
      expect(mockSupabase).not.toHaveBeenCalled();
    }
  );

  it("an entitlement group cannot carry a permission the admin lacks", async () => {
    const res = await handleCreateEntitlementGroup(
      { code: "x", display_name: "X", permissions: ["can_secret"] },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(mockSupabase).not.toHaveBeenCalled();
  });

  it("an agent-registry change refused by the governed write is not reported as done", async () => {
    mockGetConfig.mockResolvedValue([]);
    mockWrite.mockResolvedValue({ kind: "refused", permission: "config_manage_safety" });
    const res = await handleRegisterAgent({ agent_id: "a1" }, admin);
    expect(res).toMatchObject({ success: false, code: "auth.permission_denied" });
  });

  it("a held change says it is held, not applied", async () => {
    mockGetConfig.mockResolvedValue([]);
    mockWrite.mockResolvedValue({ kind: "pending", result: {} });
    const res = await handleSetCapabilityMapping(
      { capability: "c", features: ["f"] },
      admin
    );
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/held for approval/);
  });
});
