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
jest.mock("@/platform/admin/config-scope", () => {
  const actual = jest.requireActual("@/platform/admin/config-scope");
  return { ...actual, resolveConfigTarget: jest.fn(actual.resolveConfigTarget) };
});
// The tools' real schemas: the route takes only their keys (TASK-194 round 10, I-A).
jest.mock("@/platform/admin/config-handlers", () => ({
  dispatchConfigTool: jest.fn(),
  CONFIG_TOOLS: jest.requireActual("@/platform/admin/config-handlers").CONFIG_TOOLS,
  CONFIG_SERVER_SET_INPUTS: jest.requireActual("@/platform/admin/config-handlers")
    .CONFIG_SERVER_SET_INPUTS,
  configFailure: jest.requireActual("@/platform/admin/config-handlers").configFailure,
  codedConfigFailure: jest.requireActual("@/platform/admin/config-handlers")
    .codedConfigFailure,
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

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { getEnhancedConfig, getPermissionTier } from "@/platform/auth/platform-config";
import { resolveConfigTarget } from "@/platform/admin/config-scope";
import { dispatchConfigTool } from "@/platform/admin/config-handlers";
import { buildConfigManagerPrompt } from "@/prompts/admin/config-manager-v1";
import * as executeRoute from "@/app/api/admin/config-ai/execute/route";
import { getApproval } from "@/platform/admin/config-approval";
import * as conversationRoute from "@/app/api/admin/config-ai/route";
import * as configRoute from "@/app/api/admin/config/route";

// hostile:id-spelling n/a: no account id is compared by these routes: the actor is the verified admin, and the approver comparison is config-approval's

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

  it("[hostile:role] refuses an admin a safety-tier update", async () => {
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

  // TASK-194, audit C-1: the key checked must be the key the tool acts on. Every write tool, with
  // every pairing of `key` and `configKey` (a standard key, a safety key, none), as every role:
  // let through only when the caller holds the tier of the key that tool acts on — the field
  // CONFIG_TOOL_TARGET_FIELD names, which the real handlers read (config-handlers.test.ts) — and
  // dispatched with that key unchanged.
  const schemaKeys = (toolId: string): string[] =>
    Object.keys(
      (
        jest
          .requireActual("@/platform/admin/config-handlers")
          .CONFIG_TOOLS.find((t: { id: string }) => t.id === toolId)?.inputSchema as {
          properties?: object;
        }
      )?.properties ?? {}
    );

  it("checks the tier of the key each write tool acts on, whatever else the request names (C-1)", async () => {
    const { CONFIG_TOOL_TARGET_FIELD } = jest.requireActual(
      "@/platform/admin/hold-keys"
    ) as typeof import("@/platform/admin/hold-keys");
    const keys = [STANDARD_KEY, SAFETY_KEY, undefined];
    const holdsTier = (caller: CallerName, key: string | undefined) => {
      const who = CALLERS[caller as keyof typeof CALLERS];
      if (!who.inGoodStanding || !who.mfaEnabled) return false; // refused at the guard
      const perms = who.permissions as readonly string[];
      const needed =
        key !== undefined && TIERS[key] === "standard"
          ? "config_manage_standard"
          : "config_manage_safety";
      return perms.includes("config_view") && perms.includes(needed);
    };
    const mismatches: string[] = [];
    for (const toolId of Object.keys(CONFIG_TOOL_TARGET_FIELD)) {
      for (const key of keys) {
        for (const configKey of keys) {
          for (const caller of Object.keys(CALLERS) as CallerName[]) {
            dispatch.mockClear();
            const named = {
              ...(key ? { key } : {}),
              ...(configKey ? { configKey } : {}),
              value: 1,
              proposedValue: 1,
              changeComment: "c",
            };
            // Every field the request names, and — so the tier check is also proven on a
            // request the route takes — only the tool's own, in turn.
            const own = Object.fromEntries(
              Object.entries(named).filter(([k]) => schemaKeys(toolId).includes(k))
            );
            for (const input of [named, own]) {
              dispatch.mockClear();
              const res = await execute(caller, { toolId, input });
              const acted = CONFIG_TOOL_TARGET_FIELD[toolId] === "key" ? key : configKey;
              const allowed = holdsTier(caller, acted);
              if (allowed !== (res.status !== 403 && res.status !== 401))
                mismatches.push(
                  `${toolId} key=${key} configKey=${configKey} as ${caller}: ${res.status}`
                );
              // Round 10, I-A: a caller let through who names a key outside the tool's schema
              // (the other tool's target field among them) is refused — nothing dispatched; one
              // who names only the tool's own keys reaches it.
              const extra = Object.keys(input).filter(
                (k) => !schemaKeys(toolId).includes(k)
              );
              if (allowed && (res.status === 400) !== extra.length > 0)
                mismatches.push(
                  `${toolId} ${extra.join(",")} as ${caller}: ${res.status}`
                );
              if (res.status === 400 && dispatch.mock.calls.length > 0)
                mismatches.push(`${toolId}: dispatched a refused request`);
              if (res.status === 200) {
                const sent = dispatch.mock.calls[0]?.[1] as Record<string, unknown>;
                if (sent[CONFIG_TOOL_TARGET_FIELD[toolId]] !== acted)
                  mismatches.push(`${toolId}: dispatched a different key than checked`);
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
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

  it("[hostile:self] records the verified actor, overwriting a spoofed actorId and reviewerId", async () => {
    await execute("safety_approver", {
      toolId: "update_config",
      input: {
        key: SAFETY_KEY,
        value: 9,
        changeComment: "c",
        actorId: CALLERS.super_admin.userId,
      },
    });
    const input = dispatch.mock.calls[0][1];
    expect(input.actorId).toBe(CALLERS.safety_approver.userId);
    expect(input.reviewerId).toBe(CALLERS.safety_approver.userId);

    // A reviewer named on an approval (its schema's key) is overwritten too.
    approvalFor(SAFETY_KEY);
    dispatch.mockClear();
    await execute("safety_approver", {
      toolId: "approve_change",
      input: {
        approvalId: "apr-1",
        reviewerId: CALLERS.super_admin.userId,
        reviewComment: "ok",
      },
    });
    expect(dispatch.mock.calls[0][1].reviewerId).toBe(CALLERS.safety_approver.userId);

    // And one named on a change, outside its schema, is refused — never dispatched (round 10).
    dispatch.mockClear();
    const res = await execute("safety_approver", {
      toolId: "update_config",
      input: { key: SAFETY_KEY, value: 9, changeComment: "c", reviewerId: "x" },
    });
    expect(res.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
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

  // Round 13 (I-C), round 14 (items 3, 4, 5): an uncoded tool failure answers admin.action_failed
  // at that code's own status, its text logged — never in the body.
  it("[hostile:store-down] answers an uncoded tool failure admin.action_failed, its text logged, never returned", async () => {
    const { logger } = jest.requireMock("@/lib/logger") as {
      logger: { error: jest.Mock };
    };
    logger.error.mockClear();
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
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      code: "admin.action_failed",
      message: expect.any(String),
    });
    expect(text).not.toContain("Validation failed");
    expect(logger.error).toHaveBeenCalledWith(
      "Config tool failed",
      expect.objectContaining({ error: "Validation failed" })
    );
  });

  it.each([
    [
      "a change already waiting",
      {
        success: true,
        data: {
          applied: false,
          requiresApproval: true,
          approvalError: 'A pending approval already exists for "k" (row 7).',
          errorCode: "approvals.already_pending",
          errorParams: { key: STANDARD_KEY },
        },
      },
      409,
      "approvals.already_pending",
    ],
    [
      "the audit log unavailable",
      {
        success: true,
        data: {
          applied: false,
          error: "audit insert failed: relation audit_log",
          errorCode: "service.unavailable",
          errorParams: { service: "audit" },
        },
      },
      503,
      "service.unavailable",
    ],
  ])(
    "answers %s at its code's status, its text never returned (round 14)",
    async (_l, r, status, code) => {
      dispatch.mockResolvedValue({ toolId: "update_config", durationMs: 1, ...r });
      const res = await execute("admin", {
        toolId: "update_config",
        input: { key: STANDARD_KEY, value: 3, changeComment: "c" },
      });
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ code });
      expect(text).not.toMatch(/row 7|relation audit_log/);
    }
  );
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
    // A role in the body is no input (TASK-203, N-31): refused before anything is built.
    const refused = await converse("admin", {
      message: "hello",
      adminRole: "super_admin",
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      code: "request.unknown_input",
      params: { field: "adminRole" },
    });
    expect(buildConfigManagerPrompt).not.toHaveBeenCalled();
    await converse("admin", { message: "hello" });
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
        // As the handler answers it (round 14, item 2): the reason structured.
        data: {
          applied: false,
          validationErrors: ["Value 1000000000 exceeds maximum 100"],
          errorCode: "admin.config_invalid_value",
          errorParams: { key: STANDARD_KEY, reason: "above_max", max: 100 },
        },
        durationMs: 1,
      });
      const res = await put("admin", { key: STANDARD_KEY, value: 1e9 });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body).toMatchObject({
        code: "admin.config_invalid_value",
        params: { key: STANDARD_KEY, reason: "above_max", max: 100 },
        message: `${STANDARD_KEY} must be at most 100.`,
      });
    });

    // Round 14, item 1: a failed write's own code (it answered 500 for every one).
    it.each([
      ["approvals.already_pending", { key: STANDARD_KEY }, 409],
      ["service.unavailable", { service: "audit" }, 503],
      ["admin.write_indeterminate", {}, 503],
    ])(
      "answers a write that failed with %s at its status",
      async (code, params, status) => {
        dispatch.mockResolvedValue({
          toolId: "update_config",
          success: true,
          data: {
            applied: false,
            error: "db text",
            errorCode: code,
            errorParams: params,
          },
          durationMs: 1,
        });
        const res = await put("admin", { key: STANDARD_KEY, value: 5 });
        expect(res.status).toBe(status);
        const text = await res.text();
        expect(JSON.parse(text).code).toBe(code);
        expect(text).not.toContain("db text");
      }
    );

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

  describe("DELETE — back to the platform default, governed like PUT", () => {
    const target = resolveConfigTarget as jest.Mock;
    const del = (caller: CallerName, query: string) =>
      configRoute.DELETE(
        request(`/api/admin/config${query}`, caller, undefined, "DELETE")
      );
    const answer = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      dispatch.mockResolvedValue({
        toolId: "reset_config",
        success: true,
        data,
        durationMs: 1,
        ...extra,
      });

    it.each(["anonymous", "free", "moderator", "suspended_super_admin"] as const)(
      "refuses %s",
      async (caller) => {
        const res = await del(caller, `?key=${STANDARD_KEY}`);
        expect([401, 403]).toContain(res.status);
        expect(dispatch).not.toHaveBeenCalled();
      }
    );

    it("answers a reset whose filing was refused with its code (round 14, item 1)", async () => {
      answer({
        applied: false,
        requiresApproval: true,
        approvalError: "already waiting",
        errorCode: "approvals.already_pending",
        errorParams: { key: STANDARD_KEY },
      });
      const res = await del("admin", `?key=${STANDARD_KEY}`);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("approvals.already_pending");
    });

    it("needs a key", async () => {
      const res = await del("admin", "");
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("request.missing_fields");
    });

    it("answers an unknown key with 404, never creating or removing a key", async () => {
      const res = await del("super_admin", "?key=made.up");
      expect(res.status).toBe(404);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("holds the key to its tier: an admin cannot reset a safety key", async () => {
      const res = await del("admin", `?key=${SAFETY_KEY}`);
      expect(res.status).toBe(403);
      expect((await res.json()).params.permission).toBe("config_manage_safety");
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("refuses a key that governs the platform to a non-operator, before dispatch", async () => {
      target.mockReturnValueOnce({ ok: false, reason: "governs the platform" });
      const res = await del("safety_approver", `?key=${SAFETY_KEY}`);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("admin.config_scope_refused");
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("dispatches reset_config as the verified admin, through the governed runtime", async () => {
      answer({ applied: true });
      const res = await del("admin", `?key=${STANDARD_KEY}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, key: STANDARD_KEY });
      expect(dispatch).toHaveBeenCalledWith(
        "reset_config",
        expect.objectContaining({
          key: STANDARD_KEY,
          actorId: CALLERS.admin.userId,
          actorIsOperator: false,
          confirmed: true,
        }),
        undefined
      );
    });

    it("an operator's reset carries operator standing from the verified admin", async () => {
      answer({ applied: true });
      await del("super_admin", `?key=${SAFETY_KEY}`);
      expect(dispatch.mock.calls[0][1]).toMatchObject({
        actorId: CALLERS.super_admin.userId,
        actorIsOperator: true,
      });
    });

    it("nothing to reset (a single deployment, or the default already): 200 unchanged", async () => {
      answer({ applied: true, unchanged: true });
      const res = await del("admin", `?key=${STANDARD_KEY}`);
      expect(await res.json()).toEqual({
        success: true,
        key: STANDARD_KEY,
        unchanged: true,
      });
    });

    it.each([
      ["held by dual control", { applied: false }, { held: true, success: false }],
      ["awaiting a second approver", { applied: false, requiresApproval: true }, {}],
    ])("answers 202 when %s", async (_label, data, extra) => {
      answer(data, extra);
      const res = await del("super_admin", `?key=${SAFETY_KEY}`);
      expect(res.status).toBe(202);
      expect((await res.json()).pending).toBe(true);
    });

    it("answers a failed reset with 500, naming nothing internal", async () => {
      dispatch.mockResolvedValue({
        toolId: "reset_config",
        success: false,
        data: null,
        error: "db down",
        durationMs: 1,
      });
      const res = await del("admin", `?key=${STANDARD_KEY}`);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain("db down");
    });

    it("answers a thrown reset with 500", async () => {
      dispatch.mockRejectedValue(new Error("connection refused"));
      const res = await del("admin", `?key=${STANDARD_KEY}`);
      expect(res.status).toBe(500);
    });
  });
});
