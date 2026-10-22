/**
 * platform/admin/__tests__/config-routes.test.ts — config routes, authorized by the real guard
 *
 * /api/admin/config-ai/execute, /api/admin/config-ai and /api/admin/config, each called as every
 * real role (helpers/test-identities.ts): the admin guard, its permission and standing checks and
 * the governed write (platform/admin/governed-config.ts) run as in production; only token
 * verification, the database and the config tool runtime are replaced. Covers the abuse cases of
 * audit X-7: no tier bypass, no spoofed actor or role, no delete, no unvalidated write.
 */

jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/test-identities").mockMiddleware()
);
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));
jest.mock("@/platform/auth/platform-config", () => ({
  listConfig: jest.fn().mockResolvedValue([]),
  listEnhancedConfig: jest.fn().mockResolvedValue([]),
  getPermissionTier: jest.fn(),
  getEnhancedConfig: jest.fn(),
}));
jest.mock("@/platform/admin/config-handlers", () => ({
  dispatchConfigTool: jest.fn(),
  CONFIG_TOOLS: [],
}));
jest.mock("@/platform/admin/config-approval", () => ({
  isApprovalRequired: jest.fn().mockResolvedValue(false),
  getApproval: jest.fn(),
}));
jest.mock("@/prompts/admin/config-manager-v1", () => ({
  buildConfigManagerPrompt: jest.fn().mockReturnValue("system prompt"),
  buildConfigAgentIdentity: jest.fn().mockReturnValue({
    actorType: "agent",
    actorId: "config-manager-test",
    agentRole: "config-manager",
  }),
}));
jest.mock("@/platform/auth/audit", () => ({ writeAuditLog: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { getEnhancedConfig, getPermissionTier } from "@/platform/auth/platform-config";
import { dispatchConfigTool } from "@/platform/admin/config-handlers";
import { buildConfigManagerPrompt } from "@/prompts/admin/config-manager-v1";
import * as executeRoute from "@/app/api/admin/config-ai/execute/route";
import { getApproval } from "@/platform/admin/config-approval";
import * as conversationRoute from "@/app/api/admin/config-ai/route";
import * as configRoute from "@/app/api/admin/config/route";

const dispatch = dispatchConfigTool as jest.Mock;
const tierOf = getPermissionTier as jest.Mock;
const entryOf = getEnhancedConfig as jest.Mock;

const SAFETY_KEY = "moderation.strike_ban_threshold";
const STANDARD_KEY = "rate_limit_rpm";
const TIERS: Record<string, "safety" | "standard"> = {
  [SAFETY_KEY]: "safety",
  [STANDARD_KEY]: "standard",
};

function request(
  url: string,
  caller: CallerName,
  body?: unknown,
  method = "POST"
): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000${url}`), {
    method,
    headers: { "Content-Type": "application/json", ...authAs(caller) },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

const approvalFor = (configKey: string) =>
  (getApproval as jest.Mock).mockResolvedValue({ id: "apr-1", configKey });

const execute = (caller: CallerName, body: unknown) =>
  executeRoute.POST(request("/api/admin/config-ai/execute", caller, body));

beforeEach(() => {
  jest.clearAllMocks();
  // Unknown keys are safety tier, as getPermissionTier fails closed.
  tierOf.mockImplementation(async (key: string) => TIERS[key] ?? "safety");
  entryOf.mockImplementation(async (key: string) =>
    TIERS[key] ? { key, permissionTier: TIERS[key], value: 1 } : null
  );
  dispatch.mockResolvedValue({
    toolId: "x",
    success: true,
    data: { applied: true },
    durationMs: 1,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// /api/admin/config-ai/execute
// ═══════════════════════════════════════════════════════════════════════

describe("/api/admin/config-ai/execute", () => {
  const search = { toolId: "search_config", input: { query: "rate" } };

  it.each([
    ["anonymous", 401],
    ["guest", 403],
    ["free", 403],
    ["moderator", 403],
    ["suspended_super_admin", 403],
  ] as const)("refuses %s even a read tool (%i)", async (caller, status) => {
    const res = await execute(caller, search);
    expect(res.status).toBe(status);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["anonymous", "moderator"] as const)(
    "verifies %s before reading the body: a malformed body still gets 401/403 (audit I-2)",
    async (caller) => {
      const res = await execute(caller, "{not json");
      expect([401, 403]).toContain(res.status);
    }
  );

  it.each([
    ["malformed JSON", "{not json", "request.invalid_json"],
    ["null", "null", "request.invalid_body"],
    ["an array input", { toolId: "search_config", input: [1] }, "request.invalid_body"],
    ["a non-string toolId", { toolId: 7 }, "request.missing_fields"],
  ])("answers an admin's %s with a coded 400", async (_label, body, code) => {
    const res = await execute("admin", body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(code);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["admin", "safety_approver", "super_admin"] as const)(
    "lets %s run a read tool",
    async (caller) => {
      const res = await execute(caller, search);
      expect(res.status).toBe(200);
      expect(dispatch).toHaveBeenCalledWith(
        "search_config",
        expect.anything(),
        expect.anything()
      );
    }
  );

  it("refuses an admin a safety-tier update", async () => {
    const res = await execute("admin", {
      toolId: "update_config",
      input: { key: SAFETY_KEY, value: 9, changeComment: "c" },
    });
    expect(res.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses an admin a safety-tier approval request (configKey)", async () => {
    const res = await execute("admin", {
      toolId: "request_approval",
      input: { configKey: SAFETY_KEY, proposedValue: 9, changeComment: "c" },
    });
    expect(res.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("holds a write that names no key to the safety tier", async () => {
    const res = await execute("admin", { toolId: "update_config", input: { value: 1 } });
    expect(res.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lets an admin update a standard key", async () => {
    const res = await execute("admin", {
      toolId: "update_config",
      input: { key: STANDARD_KEY, value: 100, changeComment: "c" },
    });
    expect(res.status).toBe(200);
  });

  it("records the verified actor, overwriting a spoofed actorId and reviewerId", async () => {
    await execute("safety_approver", {
      toolId: "update_config",
      input: {
        key: SAFETY_KEY,
        value: 9,
        changeComment: "c",
        actorId: CALLERS.super_admin.userId,
        reviewerId: CALLERS.super_admin.userId,
      },
    });
    const input = dispatch.mock.calls[0][1];
    expect(input.actorId).toBe(CALLERS.safety_approver.userId);
    expect(input.reviewerId).toBe(CALLERS.safety_approver.userId);
  });

  it.each([
    ["admin", 403],
    ["safety_approver", 200],
    ["super_admin", 200],
  ] as const)(
    "approve_change of a safety-tier change as %s → %i",
    async (caller, status) => {
      approvalFor(SAFETY_KEY);
      const res = await execute(caller, {
        toolId: "approve_change",
        input: { approvalId: "apr-1", reviewComment: "ok" },
      });
      expect(res.status).toBe(status);
    }
  );

  it("holds an approval to its key's tier: a safety approver cannot approve a standard-tier change (release review)", async () => {
    approvalFor(STANDARD_KEY);
    const res = await execute("safety_approver", {
      toolId: "approve_change",
      input: { approvalId: "apr-1", reviewComment: "ok" },
    });
    expect(res.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("holds an approval it cannot find to the safety tier", async () => {
    (getApproval as jest.Mock).mockResolvedValue(null);
    const res = await execute("admin", {
      toolId: "reject_change",
      input: { approvalId: "missing", reviewComment: "no" },
    });
    expect(res.status).toBe(403);
  });

  it("holds an unknown tool to the safety tier", async () => {
    const res = await execute("admin", { toolId: "drop_everything", input: {} });
    expect(res.status).toBe(403);
  });

  it("returns 400 for a missing toolId", async () => {
    const res = await execute("admin", { input: {} });
    expect(res.status).toBe(400);
  });

  it("returns 422 when the tool fails", async () => {
    dispatch.mockResolvedValue({
      toolId: "update_config",
      success: false,
      data: null,
      error: "Validation failed",
      durationMs: 3,
    });
    const res = await execute("admin", {
      toolId: "update_config",
      input: { key: STANDARD_KEY, value: "bad", changeComment: "c" },
    });
    expect(res.status).toBe(422);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// /api/admin/config-ai
// ═══════════════════════════════════════════════════════════════════════

describe("/api/admin/config-ai", () => {
  const converse = (caller: CallerName, body: unknown) =>
    conversationRoute.POST(request("/api/admin/config-ai", caller, body));

  it("returns a structured response with a trajectory", async () => {
    const res = await converse("admin", { message: "Show me all moderation config" });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.trajectoryId).toMatch(/^traj-/);
    expect(Array.isArray(data.toolResults)).toBe(true);
  });

  it("returns 400 for a missing message", async () => {
    const res = await converse("admin", {});
    expect(res.status).toBe(400);
  });

  it.each(["anonymous", "free", "moderator"] as const)("refuses %s", async (caller) => {
    const res = await converse(caller, { message: "hello" });
    expect([401, 403]).toContain(res.status);
  });

  it("derives the assistant's tier from the verified admin, not the body", async () => {
    await converse("admin", { message: "hello", adminRole: "super_admin" });
    expect(buildConfigManagerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: CALLERS.admin.userId,
        adminRole: "admin",
        permissionTier: "standard",
      })
    );
  });

  it("gives a safety approver the safety tier", async () => {
    await converse("safety_approver", { message: "hello" });
    expect(buildConfigManagerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ permissionTier: "safety" })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// /api/admin/config
// ═══════════════════════════════════════════════════════════════════════

describe("/api/admin/config", () => {
  const put = (caller: CallerName, body: unknown) =>
    configRoute.PUT(request("/api/admin/config", caller, body, "PUT"));

  describe("GET", () => {
    const get = (caller: CallerName, query = "") =>
      configRoute.GET(request(`/api/admin/config${query}`, caller, undefined, "GET"));

    it.each(["anonymous", "free", "moderator"] as const)("refuses %s", async (caller) => {
      expect([401, 403]).toContain((await get(caller)).status);
    });

    it("returns enhanced entries when enhanced=true", async () => {
      const data = await (await get("admin", "?enhanced=true")).json();
      expect(data.enhanced).toBe(true);
    });

    it("returns simple entries by default", async () => {
      const data = await (await get("admin")).json();
      expect(data.enhanced).toBeUndefined();
    });
  });

  describe("PUT — through the governed write", () => {
    it("applies a standard key for an admin, as the verified admin", async () => {
      const res = await put("admin", { key: STANDARD_KEY, value: 200 });
      expect(res.status).toBe(200);
      expect(dispatch).toHaveBeenCalledWith(
        "update_config",
        expect.objectContaining({
          key: STANDARD_KEY,
          value: 200,
          actorId: CALLERS.admin.userId,
          confirmed: true,
        }),
        undefined
      );
    });

    it("refuses a safety key to an admin, before anything is dispatched", async () => {
      const res = await put("admin", { key: SAFETY_KEY, value: 9 });
      expect(res.status).toBe(403);
      expect((await res.json()).params.permission).toBe("config_manage_safety");
      expect(dispatch).not.toHaveBeenCalled();
    });

    it.each(["safety_approver", "super_admin"] as const)(
      "dispatches a safety key for %s",
      async (caller) => {
        const res = await put(caller, { key: SAFETY_KEY, value: 9 });
        expect(res.status).toBe(200);
      }
    );

    it.each(["anonymous", "free", "moderator", "suspended_super_admin"] as const)(
      "refuses %s",
      async (caller) => {
        const res = await put(caller, { key: STANDARD_KEY, value: 1 });
        expect([401, 403]).toContain(res.status);
        expect(dispatch).not.toHaveBeenCalled();
      }
    );

    it("refuses an unknown key with 404 rather than creating it", async () => {
      const res = await put("super_admin", { key: "made.up", value: 1 });
      expect(res.status).toBe(404);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("returns 422 with a coded error for an invalid value", async () => {
      dispatch.mockResolvedValue({
        toolId: "update_config",
        success: true,
        data: { applied: false, validationErrors: ["above maximum"] },
        durationMs: 1,
      });
      const res = await put("admin", { key: STANDARD_KEY, value: 1e9 });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe("admin.config_invalid_value");
    });

    it("returns 202 when the change is held for approval", async () => {
      dispatch.mockResolvedValue({
        toolId: "update_config",
        success: false,
        held: true,
        data: { pendingApproval: true },
        approval: { proposalId: "p1", operationId: "o1", requiredApprover: "user" },
        durationMs: 1,
      });
      const res = await put("super_admin", { key: SAFETY_KEY, value: 9 });
      expect(res.status).toBe(202);
      expect((await res.json()).pending).toBe(true);
    });

    it("returns 500 when the governed write fails", async () => {
      dispatch.mockResolvedValue({
        toolId: "update_config",
        success: false,
        data: null,
        error: "db down",
        durationMs: 1,
      });
      const res = await put("admin", { key: STANDARD_KEY, value: 1 });
      expect(res.status).toBe(500);
    });

    it.each([
      ["missing key", { value: 1 }],
      ["missing value", { key: STANDARD_KEY }],
      ["non-string key", { key: ["a"], value: 1 }],
    ])("returns 400 for %s", async (_label, body) => {
      const res = await put("admin", body);
      expect(res.status).toBe(400);
    });

    it("returns 400 for a malformed body", async () => {
      const res = await put("admin", "{not json");
      expect(res.status).toBe(400);
    });
  });

  it("has no DELETE: keys are removed only by migrations", () => {
    expect((configRoute as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
