/**
 * __tests__/admin-usability-routes.test.ts — the command bar's routes name people and keep a search
 * to its screen (TASK-202: N-63, N-65)
 *
 *   - POST /api/admin/ai (the planner): a search of a table outside the screen's is left out of
 *     the plan unless the request names it, and the plan says which (scopedOut); each action that
 *     acts on an account carries that account's address for the confirm step (accounts) — only
 *     for an action the admin may run, read in the tenant's transaction;
 *   - POST /api/admin/ai/execute: an account-targeting result carries its account by address
 *     (account), for the screen only; an audit search names each actor and target by address.
 *
 * The real guard runs (helpers/test-identities); the database is the fake (helpers/fake-data):
 * the statements' own SQL is proved against Postgres in __tests__/db/admin-usability.db.test.ts.
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
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-1",
}));
const mockComplete = jest.fn();
jest.mock("@/platform/ai", () => ({
  getOrchestrator: jest.fn(() => ({ complete: mockComplete })),
}));
jest.mock("@/prompts", () => ({
  getPromptConfig: jest.fn(() => ({ tier: "standard", maxTokens: 1000, name: "admin" })),
  buildAdminSystemPrompt: jest.fn(() => "sys"),
}));
const mockRun = jest.fn();
jest.mock("@/app/api/admin/ai/command-bar", () => {
  const actual = jest.requireActual("@/app/api/admin/ai/command-bar");
  return { ...actual, runCommandBarAction: (...a: unknown[]) => mockRun(...a) };
});

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { fakeData } from "./helpers/fake-data";
import { POST as planPOST } from "@/app/api/admin/ai/route";
import { POST as executePOST } from "@/app/api/admin/ai/execute/route";
import { withAccountNames } from "@/app/api/admin/ai/handlers/search";

const ACCOUNT = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
const OTHER = "1b7c1d2e-3f40-4a51-8b62-7c83d94ea5f7";

function post(
  handler: typeof planPOST,
  path: string,
  body: unknown,
  caller: CallerName = "super_admin"
) {
  return handler(
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...authAs(caller) },
    })
  );
}

/** The model plans these tool calls. */
function modelPlans(...calls: { name: string; input: Record<string, unknown> }[]) {
  mockComplete.mockResolvedValue({
    content: [
      { type: "text", text: "Here is the plan." },
      ...calls.map((c) => ({ type: "tool_use", ...c })),
    ],
  });
}

/** The fake database knows one account, by id or address (and its role). */
function knowsAccount(email = "member@example.test") {
  fakeData().answer = (sql, values) => {
    if (sql.startsWith("select id, email, role_id from users where id"))
      return values[0] === ACCOUNT ? [{ id: ACCOUNT, email, role_id: "r1" }] : [];
    if (sql.startsWith("select id, email, role_id from users where email"))
      return values[0] === email ? [{ id: ACCOUNT, email, role_id: "r1" }] : [];
    if (sql.startsWith("select id, name, is_default from roles"))
      return [{ id: "r1", name: "free", is_default: true }];
    return undefined;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeData().reset();
});

describe("POST /api/admin/ai: a search reads its own screen (N-65)", () => {
  it("drops the searches of other tables, and says which", async () => {
    modelPlans(
      { name: "search", input: { table: "platform_config", text: "ban" } },
      { name: "search", input: { table: "permissions", text: "ban" } },
      { name: "search", input: { table: "audit_log" } }
    );
    const res = await post(planPOST, "/api/admin/ai", {
      prompt: "find the ban threshold",
      panel: "platform-config",
    });
    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as {
      plan: { actions: { input: { table: string } }[]; scopedOut?: string[] };
    };
    expect(plan.actions.map((a) => a.input.table)).toEqual(["platform_config"]);
    expect(plan.scopedOut).toEqual(["permissions", "audit_log"]);
  });

  it("keeps a table the request names", async () => {
    modelPlans(
      { name: "search", input: { table: "platform_config" } },
      { name: "search", input: { table: "audit_log" } }
    );
    const res = await post(planPOST, "/api/admin/ai", {
      prompt: "show the audit log for the ban threshold",
      panel: "platform-config",
    });
    const { plan } = (await res.json()) as {
      plan: { actions: unknown[]; scopedOut?: unknown };
    };
    expect(plan.actions).toHaveLength(2);
    expect(plan.scopedOut).toBeUndefined();
  });
});

describe("POST /api/admin/ai: the confirm step names the account (N-63)", () => {
  it("an account named by address or id: its address, by the action's index", async () => {
    knowsAccount();
    modelPlans(
      { name: "search", input: { table: "users" } },
      {
        name: "change_user_role",
        input: { user_identifier: ACCOUNT, new_role: "moderator" },
      }
    );
    const res = await post(planPOST, "/api/admin/ai", {
      prompt: "make them a moderator",
      panel: "users",
    });
    const { plan } = (await res.json()) as {
      plan: { accounts?: Record<string, { email: string | null; found: boolean }> };
    };
    expect(plan.accounts).toEqual({ "1": { email: "member@example.test", found: true } });
  });

  it("[hostile:id-spelling] an id in upper case names the same account", async () => {
    knowsAccount();
    modelPlans({
      name: "block_user_feature",
      input: { user_id: ACCOUNT.toUpperCase(), feature: "translate" },
    });
    const res = await post(planPOST, "/api/admin/ai", {
      prompt: "block translate for them",
      panel: "per-account",
    });
    const { plan } = (await res.json()) as {
      plan: { accounts?: Record<string, { email: string | null }> };
    };
    expect(plan.accounts?.["0"]?.email).toBe("member@example.test");
  });

  it("an id of no account in this tenant: said not found, never named", async () => {
    knowsAccount();
    modelPlans({
      name: "block_user_feature",
      input: { user_id: OTHER, feature: "translate" },
    });
    const res = await post(planPOST, "/api/admin/ai", {
      prompt: "block translate",
      panel: "per-account",
    });
    const { plan } = (await res.json()) as {
      plan: { accounts?: Record<string, { email: string | null; found: boolean }> };
    };
    expect(plan.accounts).toEqual({ "0": { email: null, found: false } });
  });

  it("[hostile:role] an action the admin may not run names no account", async () => {
    knowsAccount();
    // A safety approver may open the console but holds no admin_manage_users.
    expect(CALLERS.safety_approver.permissions).not.toContain("admin_manage_users");
    modelPlans({
      name: "change_user_role",
      input: { user_identifier: ACCOUNT, new_role: "admin" },
    });
    const res = await post(
      planPOST,
      "/api/admin/ai",
      { prompt: "promote them", panel: "users" },
      "safety_approver"
    );
    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as { plan: { accounts?: unknown } };
    expect(plan.accounts).toBeUndefined();
    expect(
      fakeData().statements.some((s) =>
        s.sql.startsWith("select id, email, role_id from users")
      )
    ).toBe(false);
  });

  it("[hostile:store-down] the account unreadable: the plan is still answered, naming none", async () => {
    fakeData().answer = (sql) => {
      if (sql.includes("from users")) throw new Error("connection refused");
      return undefined;
    };
    modelPlans({
      name: "change_user_role",
      input: { user_identifier: ACCOUNT, new_role: "moderator" },
    });
    const res = await post(planPOST, "/api/admin/ai", { prompt: "x", panel: "users" });
    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as {
      plan: { accounts?: unknown; actions: unknown[] };
    };
    expect(plan.accounts).toBeUndefined();
    expect(plan.actions).toHaveLength(1);
  });

  // hostile:self n/a: naming an account changes no rule; the execute route refuses one's own
});

describe("POST /api/admin/ai/execute: a result names its account by address (N-63)", () => {
  it("a role change's result: no id in its text, the account by address beside it", async () => {
    knowsAccount();
    mockRun.mockResolvedValue({
      kind: "ran",
      result: { success: true, result: 'Role changed to "moderator"' },
    });
    const res = await post(executePOST, "/api/admin/ai/execute", {
      actions: [
        {
          tool: "change_user_role",
          input: { user_identifier: ACCOUNT, new_role: "moderator" },
        },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: { result: string; account?: { id: string; email: string | null } }[];
    };
    expect(results[0].result).not.toContain(ACCOUNT);
    expect(results[0].account).toEqual({ id: ACCOUNT, email: "member@example.test" });
  });

  it("a refused action names no account; a held one does", async () => {
    knowsAccount();
    mockRun.mockResolvedValueOnce({
      kind: "ran",
      result: {
        success: false,
        error: "admin.target_not_found",
        code: "admin.target_not_found",
        params: { target: "user" },
      },
    });
    let res = await post(executePOST, "/api/admin/ai/execute", {
      actions: [
        { tool: "block_user_feature", input: { user_id: ACCOUNT, feature: "x" } },
      ],
    });
    expect(
      ((await res.json()) as { results: { account?: unknown }[] }).results[0].account
    ).toBeUndefined();
    mockRun.mockResolvedValueOnce({ kind: "held", proposalId: "p-1" });
    res = await post(executePOST, "/api/admin/ai/execute", {
      actions: [
        { tool: "purge_user_data", input: { userId: ACCOUNT, reason: "user_request" } },
      ],
    });
    expect(res.status).toBe(202);
    const held = (await res.json()) as {
      results: { held: boolean; account?: unknown }[];
    };
    expect(held.results[0]).toMatchObject({
      held: true,
      account: { id: ACCOUNT, email: "member@example.test" },
    });
  });

  it("[hostile:store-down] the account unreadable: the result stands without it", async () => {
    fakeData().answer = (sql) => {
      if (sql.includes("from users")) throw new Error("connection refused");
      return undefined;
    };
    mockRun.mockResolvedValue({
      kind: "ran",
      result: { success: true, result: "Blocked" },
    });
    const res = await post(executePOST, "/api/admin/ai/execute", {
      actions: [
        { tool: "block_user_feature", input: { user_id: ACCOUNT, feature: "x" } },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: { success: boolean; account?: unknown }[];
    };
    expect(results[0]).toMatchObject({ success: true });
    expect(results[0].account).toBeUndefined();
  });

  it("[hostile:role] an action the admin lacks the permission for is refused before any name is read", async () => {
    const res = await post(
      executePOST,
      "/api/admin/ai/execute",
      {
        actions: [
          {
            tool: "change_user_role",
            input: { user_identifier: ACCOUNT, new_role: "admin" },
          },
        ],
      },
      "safety_approver"
    );
    const { results } = (await res.json()) as {
      results: { code: string; account?: unknown }[];
    };
    expect(results[0].code).toBe("auth.permission_denied");
    expect(results[0].account).toBeUndefined();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("[hostile:id-spelling] an account named in upper case is named by its address", async () => {
    knowsAccount();
    mockRun.mockResolvedValue({
      kind: "ran",
      result: { success: true, result: "Blocked" },
    });
    const res = await post(executePOST, "/api/admin/ai/execute", {
      actions: [
        {
          tool: "block_user_feature",
          input: { user_id: ACCOUNT.toUpperCase(), feature: "x" },
        },
      ],
    });
    const { results } = (await res.json()) as {
      results: { account?: { email: string } }[];
    };
    expect(results[0].account?.email).toBe("member@example.test");
  });

  // hostile:self n/a: the name is added after the action ran; self rules are the handlers'
});

describe("an audit search names its actors and targets (N-63)", () => {
  it("adds who and acting-on by address before the id columns, for the screen only", async () => {
    fakeData().answer = (sql) =>
      sql.includes("from users u")
        ? [
            {
              id: ACCOUNT,
              sub: null,
              email: "member@example.test",
              role: "Free",
              erased: false,
            },
            { id: OTHER, sub: null, email: null, role: "Free", erased: true },
          ]
        : undefined;
    const out = await withAccountNames({
      success: true,
      table: {
        table: "audit_log",
        columns: ["id", "action", "actor_id", "target_id", "created_at"],
        rows: [["e1", "admin_action", ACCOUNT, OTHER, "2026-01-01T00:00:00.000Z"]],
      },
    });
    expect(out.table?.columns).toEqual([
      "id",
      "action",
      "actor",
      "target",
      "actor_id",
      "target_id",
      "created_at",
    ]);
    // The erased account's name is the catalog's key (TASK-206): the grid words it.
    expect(out.table?.rows[0].slice(2, 4)).toEqual([
      "member@example.test",
      { key: "screens.admin_console.people.erased" },
    ]);
  });

  it("leaves any other table as it is", async () => {
    const result = {
      success: true,
      table: { table: "users", columns: ["id"], rows: [["x"]] },
    };
    expect(await withAccountNames(result)).toBe(result);
  });
});
