/**
 * __tests__/admin-ai-command-bar.test.ts — coverage remediation (ADR-040 "B", B4).
 *
 * The ai command-bar plan route (ai/route.ts), the execute route (ai/execute/route.ts),
 * and the static tool-schemas (importing the aggregator covers all eight schema files).
 */
// The real admin guard runs; only token verification and the role lookups are test callers
// (helpers/test-identities.ts — Adversarial Validation practice 5).
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
// Panel context reads go to a fake platform/data (helpers/fake-data.ts); its SQL and tenancy are
// proved in __tests__/db/admin-tenant-data.db.test.ts.
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-1",
}));
jest.mock("@/platform/ai", () => ({ getOrchestrator: jest.fn() }));
jest.mock("@/prompts", () => ({
  getPromptConfig: jest.fn(() => ({ tier: "standard", maxTokens: 1000, name: "admin" })),
  buildAdminSystemPrompt: jest.fn(() => "sys"),
}));
jest.mock("@/platform/agents/tool-invoker", () => ({ invokeTool: jest.fn() }));
jest.mock("@/platform/agents/trajectory-store", () => ({
  getTrajectoryStore: jest.fn(() => ({
    create: jest.fn().mockResolvedValue({ trajectory: { trajectoryId: "t1" } }),
  })),
}));
jest.mock("@/platform/agents/proposal-store", () => ({
  getProposalStore: jest.fn(() => ({})),
}));

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { fakeData } from "./helpers/fake-data";
import { getOrchestrator } from "@/platform/ai";
import { invokeTool } from "@/platform/agents/tool-invoker";

import { POST as planPOST } from "@/app/api/admin/ai/route";
import { POST as executePOST } from "@/app/api/admin/ai/execute/route";
import { SHARED_TOOLS, PANEL_TOOL_SCHEMAS } from "@/app/api/admin/ai/tool-schemas";

const mockOrchestrator = getOrchestrator as jest.Mock;
const mockInvokeTool = invokeTool as jest.Mock;

function jsonReq(
  body: unknown,
  raw?: string,
  caller: CallerName = "super_admin"
): NextRequest {
  const serialized = raw !== undefined ? raw : JSON.stringify(body);
  return new NextRequest("http://localhost/api/admin/ai", {
    method: "POST",
    body: serialized,
    headers: { "content-type": "application/json", ...authAs(caller) },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeData().reset();
});

describe("ai plan route", () => {
  beforeEach(() => {
    mockOrchestrator.mockReturnValue({
      complete: jest.fn().mockResolvedValue({
        content: [
          { type: "text", text: "Here is the plan" },
          { type: "tool_use", name: "create_role", input: { name: "ops" } },
        ],
      }),
    });
  });

  it("returns a plan of message + actions", async () => {
    const res = await planPOST(jsonReq({ prompt: "make a role", panel: "roles" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.message).toMatch(/Here is the plan/);
    expect(body.plan.actions[0].tool).toBe("create_role");
  });

  it("builds context for the users panel", async () => {
    fakeData().answer = (sql) => (sql.includes("count(*)") ? [{ n: 5 }] : []);
    const res = await planPOST(jsonReq({ prompt: "x", panel: "users" }));
    expect(res.status).toBe(200);
  });

  it("plans without context when the context cannot be read", async () => {
    fakeData().answer = () => {
      throw new Error("down");
    };
    const res = await planPOST(jsonReq({ prompt: "x", panel: "roles" }));
    expect(res.status).toBe(200);
  });

  it("builds context for the entitlements panel", async () => {
    const res = await planPOST(jsonReq({ prompt: "x", panel: "entitlements" }));
    expect(res.status).toBe(200);
  });

  it("400s when prompt or panel is missing", async () => {
    const res = await planPOST(jsonReq({ panel: "roles" }));
    expect(res.status).toBe(400);
  });

  it("500s when the orchestrator fails", async () => {
    mockOrchestrator.mockReturnValue({
      complete: jest.fn().mockRejectedValue(new Error("down")),
    });
    const res = await planPOST(jsonReq({ prompt: "x", panel: "roles" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("service.unavailable");
  });

  it("refuses a caller who cannot enter the admin area", async () => {
    const res = await planPOST(
      jsonReq({ prompt: "x", panel: "roles" }, undefined, "free")
    );
    expect(res.status).toBe(403);
  });
});

describe("ai execute route", () => {
  it("runs an action through the governed runtime", async () => {
    mockInvokeTool.mockResolvedValue({ output: { success: true, result: "done" } });
    const body = {
      actions: [{ tool: "create_role", input: { name: "ops" } }],
      prompt: "x",
    };
    const res = await executePOST(jsonReq(body));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.results[0].success).toBe(true);
    expect(parsed.results[0].result).toBe("done");
  });

  it("400s when actions is not an array", async () => {
    const res = await executePOST(jsonReq({ actions: "nope" }));
    expect(res.status).toBe(400);
  });

  it("reports an unknown tool and stops", async () => {
    const res = await executePOST(jsonReq({ actions: [{ tool: "bogus" }] }));
    const parsed = await res.json();
    expect(parsed.results[0].success).toBe(false);
    expect(parsed.results[0].error).toMatch(/Unknown tool/);
  });

  it("captures an invokeTool failure", async () => {
    mockInvokeTool.mockRejectedValue(new Error("gated"));
    const body = { actions: [{ tool: "create_role", input: {} }] };
    const res = await executePOST(jsonReq(body));
    const parsed = await res.json();
    expect(parsed.results[0].success).toBe(false);
  });

  it.each([
    ["anonymous", 401],
    ["free", 403],
    ["suspended_super_admin", 403],
  ] as const)("refuses %s (%i)", async (caller, status) => {
    const body = { actions: [{ tool: "create_role", input: { name: "x" } }] };
    const res = await executePOST(jsonReq(body, undefined, caller));
    expect(res.status).toBe(status);
    expect(mockInvokeTool).not.toHaveBeenCalled();
  });

  // TASK-145 / audit X-1: entering the admin area does not authorize an action.
  it.each([
    ["moderator", "change_user_role", "admin_manage_users"],
    ["moderator", "create_role", "admin_manage_roles"],
    ["safety_approver", "assign_permissions", "admin_manage_roles"],
    ["safety_approver", "change_user_role", "admin_manage_users"],
    ["admin", "create_role", "admin_manage_roles"],
    ["admin", "register_agent", "admin_manage_agents"],
    ["admin", "set_approval_policy", "admin_manage_approval_policy"],
    ["admin", "block_user_feature", "admin_manage_account_restrictions"],
  ] as const)("refuses %s the %s action", async (caller, tool, permission) => {
    const res = await executePOST(
      jsonReq({ actions: [{ tool, input: {} }] }, undefined, caller)
    );
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.results[0]).toMatchObject({
      success: false,
      code: "auth.permission_denied",
      params: { permission },
    });
    expect(mockInvokeTool).not.toHaveBeenCalled();
  });

  it("stops at the first refused action, running nothing after it", async () => {
    mockInvokeTool.mockResolvedValue({ output: { success: true, result: "ok" } });
    const body = {
      actions: [
        { tool: "search", input: { table: "users" } },
        { tool: "create_role", input: { name: "x" } },
        { tool: "search", input: { table: "users" } },
      ],
    };
    const parsed = await (await executePOST(jsonReq(body, undefined, "admin"))).json();
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[1].code).toBe("auth.permission_denied");
    expect(mockInvokeTool).toHaveBeenCalledTimes(1);
  });

  it("records the verified admin as the principal", async () => {
    mockInvokeTool.mockResolvedValue({ output: { success: true, result: "ok" } });
    await executePOST(
      jsonReq({ actions: [{ tool: "search", input: { table: "users" } }] })
    );
    expect(mockInvokeTool.mock.calls[0][0].actor.onBehalfOf).toBe(
      CALLERS.super_admin.userId
    );
  });

  it("refuses more than 20 actions in one plan", async () => {
    const actions = Array.from({ length: 21 }, () => ({ tool: "search", input: {} }));
    const res = await executePOST(jsonReq({ actions }));
    expect(res.status).toBe(400);
    expect(mockInvokeTool).not.toHaveBeenCalled();
  });

  it.each([null, 7, "x", [null], [{ tool: { toString: "create_role" } }]])(
    "handles the malformed actions %p without a server error",
    async (actions) => {
      const res = await executePOST(jsonReq({ actions }));
      expect(res.status).toBeLessThan(500);
      expect(mockInvokeTool).not.toHaveBeenCalled();
    }
  );

  it("returns 400 for a body that is not JSON", async () => {
    const res = await executePOST(jsonReq(undefined, "{nope"));
    expect(res.status).toBe(400);
  });
});

describe("tool-schemas", () => {
  it("SHARED_TOOLS includes the search tool", () => {
    expect(SHARED_TOOLS.some((t) => t.name === "search")).toBe(true);
  });

  it("every panel tool is well-formed", () => {
    const all = Object.values(PANEL_TOOL_SCHEMAS).flat();
    expect(all.length).toBeGreaterThan(0);
    for (const tool of all) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.input_schema).toBeDefined();
    }
  });
});
