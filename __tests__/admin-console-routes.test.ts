/**
 * @jest-environment node
 */
/**
 * TASK-216 — the small route changes the console's core needs, on the real handlers:
 *
 *   GET  /api/admin/session   who is signed in — the admin's own address and display name
 *                             (SF-admin-005), read in the tenant's transaction; none, or a read
 *                             that fails, names no one and never refuses the session;
 *   GET  /api/admin/users     how many accounts match (SF-admin-041), counted with the list's
 *   POST …/users/search       own conditions and capped — both readers of the list (the
 *                             search text only in the POST's body, TASK-215);
 *   POST /api/admin/ai        the display name of each role a plan names (SF-admin-013), only
 *                             for an action the admin may run.
 *
 * The count's own SQL is run on a real database in __tests__/db/admin-users-count.db.test.ts.
 *
 * hostile:role covered: a caller without the action's permission is sent no role name
 * hostile:store-down covered: the name read failing still answers the session, naming no one
 * hostile:self n/a: these are reads; none takes a target the caller could be
 * hostile:id-spelling covered: the admin's own id in upper case reads the same account
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
jest.mock("@/platform/auth/email-verification", () => ({
  ...jest.requireActual("@/platform/auth/email-verification"),
  syncAccountAddress: jest.fn(async () => "unchanged"),
}));
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

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { fakeData } from "./helpers/fake-data";
import { GET as sessionGET } from "@/app/api/admin/session/route";
import { GET as usersGET } from "@/app/api/admin/users/route";
import { POST as usersSearchPOST } from "@/app/api/admin/users/search/route";
import { USER_COUNT_CAP } from "@/app/api/admin/users/listing";
import { POST as planPOST } from "@/app/api/admin/ai/route";
import { ownAccountName } from "@/platform/admin/account-names";

const get = (handler: typeof sessionGET, path: string, caller: CallerName) =>
  handler(new NextRequest(`http://localhost${path}`, { headers: authAs(caller) }));

beforeEach(() => {
  jest.clearAllMocks();
  fakeData().reset();
});

const NAME_SQL = "select u.email, u.display_name from users u";

describe("GET /api/admin/session names who is signed in (SF-admin-005)", () => {
  it("the admin's own address and display name, read by their own id", async () => {
    fakeData().answer = (sql, values) =>
      sql.startsWith(NAME_SQL) && values[0] === CALLERS.admin.userId.toLowerCase()
        ? [{ email: "ann@example.test", display_name: "Ann Admin" }]
        : undefined;
    const res = await get(sessionGET, "/api/admin/session", "admin");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      userId: CALLERS.admin.userId,
      roleName: "admin",
      email: "ann@example.test",
      displayName: "Ann Admin",
    });
    // Only the two columns of the caller's own row, and only a live account.
    const read = fakeData().statements.find((s) => s.sql.startsWith(NAME_SQL))!;
    expect(read.sql).toMatch(/where u\.id = \$1::uuid and u\.deleted_at is null/);
    expect(read.values).toEqual([CALLERS.admin.userId.toLowerCase()]);
  });

  it("no row, or blank values: null — the header then shows the role alone", async () => {
    let body = await (await get(sessionGET, "/api/admin/session", "admin")).json();
    expect([body.email, body.displayName]).toEqual([null, null]);
    fakeData().answer = (sql) =>
      sql.startsWith(NAME_SQL) ? [{ email: "  ", display_name: "" }] : undefined;
    body = await (await get(sessionGET, "/api/admin/session", "admin")).json();
    expect([body.email, body.displayName]).toEqual([null, null]);
  });

  it("[hostile:store-down] the read failing never refuses the session: it names no one", async () => {
    fakeData().answer = (sql) => {
      if (sql.startsWith(NAME_SQL)) throw new Error("connection refused");
      return undefined;
    };
    const res = await get(sessionGET, "/api/admin/session", "moderator");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect([body.email, body.displayName]).toEqual([null, null]);
    expect(body.permissions.length).toBeGreaterThan(0);
  });

  it("[hostile:role] a refused caller is named nothing, and nothing is read", async () => {
    const res = await get(sessionGET, "/api/admin/session", "free");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.email).toBeUndefined();
    expect(fakeData().statements.some((s) => s.sql.startsWith(NAME_SQL))).toBe(false);
  });

  it("[hostile:id-spelling] an id in upper case reads the same account; one that is no id reads none", async () => {
    fakeData().answer = (sql) =>
      sql.startsWith(NAME_SQL) ? [{ email: "a@b.test", display_name: null }] : undefined;
    const id = "0B7C1D2E-3F40-4A51-8B62-7C83D94EA5F6";
    expect(await ownAccountName(id)).toEqual({ email: "a@b.test", displayName: null });
    expect(fakeData().statements.at(-1)!.values).toEqual([id.toLowerCase()]);
    fakeData().reset();
    expect(await ownAccountName("dev-bypass")).toEqual({
      email: null,
      displayName: null,
    });
    expect(await ownAccountName("x' or '1'='1")).toEqual({
      email: null,
      displayName: null,
    });
    expect(fakeData().statements).toHaveLength(0);
  });
});

describe("the Users list counts what it matches (SF-admin-041)", () => {
  const COUNT = "select count(*)::int as n from (select 1 from users u";
  const counts = (n: number) => {
    fakeData().answer = (sql) => (sql.startsWith(COUNT) ? [{ n }] : undefined);
  };
  /** The screen's read: POST …/search, its parameters (the search text too) in the body. */
  const search = (
    body: Record<string, string | number>,
    caller: CallerName = "super_admin"
  ) =>
    usersSearchPOST(
      new NextRequest("http://localhost/api/admin/users/search", {
        method: "POST",
        headers: { ...authAs(caller), "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 25, ...body }),
      })
    );
  const page = async (body: Record<string, string | number> = {}) =>
    ((await (await search(body)).json()) as { page: Record<string, unknown> }).page;

  it("GET, the list with no search text, says its total too", async () => {
    counts(312);
    const res = await get(
      usersGET,
      "/api/admin/users?limit=25&role=Moderator",
      "super_admin"
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { page: unknown }).page).toMatchObject({
      total: 312,
      totalCapped: false,
    });
  });

  it("the total, beside the page", async () => {
    counts(312);
    expect(await page()).toMatchObject({
      total: 312,
      totalCapped: false,
      hasMore: false,
    });
  });

  it("the count has the list's own conditions, bound — and its own numbering of them", async () => {
    counts(1);
    await page({
      q: "jo%hn",
      role: "Moderator",
      status: "active",
      signed_in_within_days: 7,
      created_within_days: 30,
      text: "x_y",
    });
    const list = fakeData().statements.find(
      (s) => /from users u where/.test(s.sql) && !s.sql.startsWith(COUNT)
    )!;
    const count = fakeData().statements.find((s) => s.sql.startsWith(COUNT))!;
    // The same conditions, in the same order, after the list's limit and offset.
    expect(count.values).toEqual([
      list.values[0],
      ...list.values.slice(3),
      USER_COUNT_CAP + 1,
    ]);
    // Every parameter the count names is one it is given: $1 to $7, no other.
    const named = [...new Set(count.sql.match(/\$\d+/g))].sort();
    expect(named).toEqual(["$1", "$2", "$3", "$4", "$5", "$6", "$7"]);
    expect(count.sql).toMatch(/limit \$7\) matched$/);
    // Nothing of the request is written into the statement.
    expect(count.sql).not.toMatch(/jo|Moderator|x_y/);
  });

  it("capped: a very large tenant is 'more than', never an unbounded count", async () => {
    counts(USER_COUNT_CAP + 1);
    expect(await page()).toMatchObject({ total: USER_COUNT_CAP, totalCapped: true });
    counts(USER_COUNT_CAP);
    expect(await page()).toMatchObject({ total: USER_COUNT_CAP, totalCapped: false });
  });

  it("[hostile:role] a caller who may not list users is sent no count", async () => {
    counts(312);
    expect((await get(usersGET, "/api/admin/users", "moderator")).status).toBe(403);
    const res = await search({}, "moderator");
    expect(res.status).toBe(403);
    expect(fakeData().statements.some((s) => s.sql.startsWith(COUNT))).toBe(false);
  });
});

describe("POST /api/admin/ai names the roles a plan names (SF-admin-013)", () => {
  const ROLES_SQL = "select name, display_name from roles where name = any";
  function modelPlans(...calls: { name: string; input: Record<string, unknown> }[]) {
    mockComplete.mockResolvedValue({
      content: [
        { type: "text", text: "Plan." },
        ...calls.map((c) => ({ type: "tool_use", ...c })),
      ],
    });
  }
  const plan = async (panel: string, caller: CallerName = "super_admin") => {
    const res = await planPOST(
      new NextRequest("http://localhost/api/admin/ai", {
        method: "POST",
        headers: { ...authAs(caller), "content-type": "application/json" },
        body: JSON.stringify({ prompt: "do it", panel }),
      })
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { plan: { roles?: Record<string, string> } }).plan;
  };
  const knowsRoles = () => {
    fakeData().answer = (sql, values) =>
      sql.startsWith(ROLES_SQL)
        ? [
            { name: "mod_l2", display_name: "Senior Moderator" },
            { name: "bare", display_name: null },
          ].filter((r) => (values[0] as string[]).includes(r.name))
        : undefined;
  };

  it("each role an action names, by its stored name: the catalogue's display name", async () => {
    knowsRoles();
    modelPlans(
      { name: "delete_role", input: { role_name: "mod_l2" } },
      { name: "duplicate_role", input: { source_role: "bare", new_name: "copy" } },
      { name: "assign_permissions", input: { role_name: "gone", add: [] } }
    );
    const { roles } = await plan("roles");
    // A role with no display name, or not in the catalogue, has none here: the screen writes
    // its stored name readably itself.
    expect(roles).toEqual({ mod_l2: "Senior Moderator" });
    const read = fakeData().statements.find((s) => s.sql.startsWith(ROLES_SQL))!;
    expect([...(read.values[0] as string[])].sort()).toEqual(["bare", "gone", "mod_l2"]);
  });

  it("a plan that names no role reads none and sends none", async () => {
    knowsRoles();
    modelPlans({ name: "search", input: { table: "roles" } });
    expect((await plan("roles")).roles).toBeUndefined();
    expect(fakeData().statements.some((s) => s.sql.startsWith(ROLES_SQL))).toBe(false);
  });

  it("[hostile:role] an action the admin may not run names no role", async () => {
    knowsRoles();
    expect(CALLERS.safety_approver.permissions).not.toContain("admin_manage_users");
    modelPlans({
      name: "change_user_role",
      input: { user_identifier: "x", new_role: "mod_l2" },
    });
    expect((await plan("users", "safety_approver")).roles).toBeUndefined();
    expect(fakeData().statements.some((s) => s.sql.startsWith(ROLES_SQL))).toBe(false);
  });

  it("a plan's input is answered as the model proposed it — a policy's rules, a list of objects, too", async () => {
    // Declared as scalars only (56c), this plan was refused here and its rules stripped in
    // production: the screen could not show what it would set. The route that runs a plan checks
    // each input against its tool's schema (app/api/admin/ai/execute/route.ts).
    const rules = [
      { max_risk: "ordinary", required_approver: "user", effects: ["write"] },
      { max_risk: "consequential", required_approver: "user" },
    ];
    modelPlans({
      name: "set_approval_policy",
      input: { rules, default_approver: "user" },
    });
    const answered = (await plan("approval-policy")) as unknown as {
      actions: { tool: string; input: Record<string, unknown> }[];
    };
    expect(answered.actions).toEqual([
      { tool: "set_approval_policy", input: { rules, default_approver: "user" } },
    ]);
  });

  it("[hostile] a role name that is not text, is empty, or is over the catalogue's 64 characters is not looked up", async () => {
    knowsRoles();
    modelPlans(
      { name: "delete_role", input: { role_name: { $ne: null } } },
      { name: "delete_role", input: { role_name: "" } },
      { name: "delete_role", input: { role_name: "r".repeat(65) } }
    );
    expect((await plan("roles")).roles).toBeUndefined();
    expect(fakeData().statements.some((s) => s.sql.startsWith(ROLES_SQL))).toBe(false);
  });
});
