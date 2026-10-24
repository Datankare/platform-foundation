/**
 * __tests__/admin-ai-handlers.test.ts — coverage remediation (ADR-040 "B", B3b).
 *
 * The remaining ai command-bar handlers: agents, approval, config, entitlements,
 * mapping, restrictions, search. Success, validation, not-found, and store/db error
 * branches for each.
 *
 * platform/data is a fake here (helpers/fake-data.ts): the real audit module records through it,
 * and a test injects database failures. The SQL of the entitlement, restriction and search
 * handlers — and their tenancy — is proved against Postgres in
 * __tests__/db/admin-catalog.db.test.ts and __tests__/db/admin-tenant-data.db.test.ts.
 */
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
jest.mock("@/platform/auth/password-policy", () => ({
  ...jest.requireActual("@/platform/auth/password-policy"),
  getGlobalPasswordPolicy: jest.fn(),
  saveGlobalPasswordPolicy: jest.fn(),
}));
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

import { getConfig } from "@/platform/auth/platform-config";
import { writeGovernedConfig } from "@/platform/admin/governed-config";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { fakeData } from "./helpers/fake-data";
import {
  DEFAULT_POLICY,
  getGlobalPasswordPolicy,
  saveGlobalPasswordPolicy,
} from "@/platform/auth/password-policy";
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

beforeEach(() => {
  jest.clearAllMocks();
  mockWrite.mockResolvedValue({ kind: "applied", result: {} });
  // Audit records go to a database that accepts them unless a test says otherwise.
  fakeData().reset();
  (getGlobalPasswordPolicy as jest.Mock).mockResolvedValue({ ...DEFAULT_POLICY });
  (saveGlobalPasswordPolicy as jest.Mock).mockResolvedValue({ success: true });
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
  const ACTOR = "00000000-0000-4000-8000-00000000a001";
  const saved = () => (saveGlobalPasswordPolicy as jest.Mock).mock.calls;

  it("records, then saves the policy, changing only the fields sent", async () => {
    const res = await handleUpdatePasswordPolicy({ min_length: 14 }, ACTOR);
    expect(res.success).toBe(true);
    expect(saved()).toEqual([[{ ...DEFAULT_POLICY, minLength: 14 }]]);
    expect(fakeData().audit[0]).toMatchObject({
      actor_id: ACTOR,
      details: expect.objectContaining({ type: "update_password_policy" }),
    });
  });

  it("starts from the stored policy", async () => {
    (getGlobalPasswordPolicy as jest.Mock).mockResolvedValue({
      ...DEFAULT_POLICY,
      minLength: 20,
    });
    await handleUpdatePasswordPolicy({ rotation_days: 0 }, ACTOR);
    expect(saved()[0][0]).toMatchObject({ minLength: 20, rotationDays: 0 });
  });

  it("surfaces a save failure, recording it as failed", async () => {
    (saveGlobalPasswordPolicy as jest.Mock).mockResolvedValue({
      success: false,
      error: "down",
    });
    const res = await handleUpdatePasswordPolicy({ min_length: 14 }, ACTOR);
    expect(res).toMatchObject({ success: false, error: "down" });
    expect(fakeData().audit.map((r) => r.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
  });

  it("does not save when the audit log is unavailable", async () => {
    fakeData().failAudit = true;
    const res = await handleUpdatePasswordPolicy({ min_length: 14 }, ACTOR);
    expect(res).toMatchObject({ success: false, code: "service.unavailable" });
    expect(saved()).toEqual([]);
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
    const res = await handleUpdatePasswordPolicy(input, ACTOR);
    expect(res).toMatchObject({ success: false, code: "request.invalid_value" });
    expect(res.params?.field).toBe(field);
    expect(saved()).toEqual([]);
    expect(fakeData().audit).toEqual([]);
  });
});

describe("entitlements handler", () => {
  // In a request with no tenant scope the deployment is not shared: the admin may change the
  // catalog (the shared-deployment rule is proved in __tests__/db/admin-catalog.db.test.ts).
  it("surfaces an insert error", async () => {
    fakeData().answer = (sql) => {
      if (sql.startsWith("insert into entitlement_groups")) throw new Error("dup");
      return undefined;
    };
    const res = await handleCreateEntitlementGroup(
      { code: "pro", display_name: "Pro" },
      admin
    );
    expect(res).toMatchObject({
      success: false,
      error: "The change could not be saved: the database is unavailable or refused it.",
    });
    expect(JSON.stringify(res)).not.toContain("dup");
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
  const USER = "00000000-0000-4000-8000-00000000b001";
  const ACTOR = "00000000-0000-4000-8000-00000000a001";

  it("rejects a block with missing fields", async () => {
    const res = await handleBlockUserFeature({ user_id: USER }, ACTOR);
    expect(res.success).toBe(false);
    expect(fakeData().statements).toEqual([]);
  });

  it("surfaces a block error, recording it as failed", async () => {
    fakeData().answer = () => {
      throw new Error("no");
    };
    const res = await handleBlockUserFeature({ user_id: USER, feature: "chat" }, ACTOR);
    expect(res).toMatchObject({
      success: false,
      error: "The change could not be saved: the database is unavailable or refused it.",
    });
    expect(fakeData().audit.map((r) => r.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
  });

  it("surfaces an unblock error", async () => {
    fakeData().answer = () => {
      throw new Error("no");
    };
    const res = await handleUnblockUserFeature({ user_id: USER, feature: "chat" }, ACTOR);
    expect(res).toMatchObject({
      success: false,
      error: "The change could not be saved: the database is unavailable or refused it.",
    });
  });

  it("rejects an unblock with missing fields", async () => {
    const res = await handleUnblockUserFeature({ feature: "chat" }, ACTOR);
    expect(res.success).toBe(false);
  });
});

describe("search handler", () => {
  it("returns the rows read", async () => {
    fakeData().answer = () => [{ r: { id: "00000000-0000-4000-8000-00000000b001" } }];
    const res = await handleSearch({ table: "users" }, admin);
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/00000000-0000-4000-8000-00000000b001/);
    expect(fakeData().statements[0].sql).toBe(
      "select to_jsonb(t) as r from users t limit 20"
    );
  });

  it("surfaces a query error", async () => {
    fakeData().answer = () => {
      throw new Error("bad");
    };
    const res = await handleSearch({ table: "users" }, admin);
    expect(res).toMatchObject({ success: false, error: "bad" });
  });
});

describe("hostile cases", () => {
  it("search refuses a table outside the allowlist", async () => {
    const res = await handleSearch({ table: "user_feature_restrictions" }, admin);
    expect(res).toMatchObject({ success: false, code: "request.invalid_value" });
    expect(fakeData().statements).toEqual([]);
  });

  it("search refuses an allowlisted table whose permission the admin lacks", async () => {
    const res = await handleSearch({ table: "audit_log" }, admin);
    expect(res).toMatchObject({
      success: false,
      code: "auth.permission_denied",
      params: { permission: "admin_view_audit" },
    });
    expect(fakeData().statements).toEqual([]);
  });

  it.each(["__proto__", "constructor", "toString", "users; drop table users"])(
    "search refuses the crafted table name %p",
    async (table) => {
      const res = await handleSearch({ table }, admin);
      expect(res.success).toBe(false);
      expect(fakeData().statements).toEqual([]);
    }
  );

  it("an entitlement group cannot carry a permission the admin lacks", async () => {
    const res = await handleCreateEntitlementGroup(
      { code: "x", display_name: "X", permissions: ["can_secret"] },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(fakeData().statements).toEqual([]);
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
