/**
 * __tests__/admin-read-failures.test.ts — a read that fails stops a privileged change
 * (release review, Sprint 7X)
 *
 * An unread role is not a role with no permissions, and an unread permission list is not an
 * empty one: either would pass the grant rule. platform/data is a fake here
 * (helpers/fake-data.ts) so each lookup can be made to fail — a real database does not fail on
 * demand. The lookups' SQL is proved in __tests__/db/admin-tenant-data.db.test.ts and
 * __tests__/db/admin-catalog.db.test.ts.
 */
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
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
}));

import { NextRequest } from "next/server";
import type { Tx } from "@/platform/data";
import { authAs, CALLERS } from "@/__tests__/helpers/test-identities";
import { fakeData } from "./helpers/fake-data";
import { findRole, findUser, LookupUnavailableError } from "@/platform/auth/role-lookup";
import { handleChangeUserRole } from "@/app/api/admin/ai/handlers/roles";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { GET as usersGET, PATCH as usersPATCH } from "@/app/api/admin/users/route";
import { GET as auditGET } from "@/app/api/admin/audit/route";
import { GET as rolesGET } from "@/app/api/admin/roles/route";
import { GET as perAccountGET } from "@/app/api/admin/per-account/route";
import { GET as entGET, PATCH as entPATCH } from "@/app/api/admin/entitlements/route";

const USER = "00000000-0000-4000-8000-00000000b001";
const ROLE_OPS = "00000000-0000-4000-8000-000000000001";
const ROLE_NEW = "00000000-0000-4000-8000-000000000002";
const GROUP = "00000000-0000-4000-8000-000000000003";

const admin: VerifiedAdmin = {
  userId: "00000000-0000-4000-8000-00000000a001",
  sub: "sub-admin",
  roleName: "admin",
  permissions: ["admin_manage_users", "can_play"],
};

/** A database holding one user (role ops) and two roles, each with can_play. */
function answerer(failing?: RegExp) {
  return (sql: string, values: readonly unknown[] = []): unknown[] | undefined => {
    if (failing?.test(sql)) throw new Error("relation unavailable");
    // The direct change is tested here: role changes are not on the dual-control list.
    if (/from platform_config/.test(sql) && values[0] === "admin.dual_control_actions") {
      return [{ value: [] }];
    }
    if (sql.startsWith("select id, cognito_sub, role_id from users")) {
      return [{ id: USER, cognito_sub: "sub-u", role_id: ROLE_OPS }];
    }
    if (sql.startsWith("select id, name, is_default from roles where name")) {
      return [{ id: ROLE_NEW, name: "staff" }];
    }
    if (sql.startsWith("select id, name, is_default from roles where id")) {
      return [{ id: ROLE_OPS, name: "ops" }];
    }
    if (sql.startsWith("select p.code from permissions p")) return [{ code: "can_play" }];
    return undefined;
  };
}
const updates = () => fakeData().statements.filter((s) => /^update /.test(s.sql));

beforeEach(() => fakeData().reset());

describe("role-lookup", () => {
  const tx = (rows: unknown[] | Error): Tx =>
    ({
      tenantId: undefined,
      query: jest.fn(async () => {
        if (rows instanceof Error) throw rows;
        return { rows, rowCount: rows.length };
      }),
    }) as unknown as Tx;

  it.each([
    ["findRole by name", (t: Tx) => findRole(t, { name: "ops" })],
    ["findRole by id", (t: Tx) => findRole(t, { id: ROLE_OPS })],
    ["findUser", (t: Tx) => findUser(t, USER)],
  ])("%s throws LookupUnavailableError on a read error", async (_l, run) => {
    await expect(run(tx(new Error("boom")))).rejects.toThrow(LookupUnavailableError);
  });

  it("a role id that is not an id names no role, without a query", async () => {
    const t = tx([]);
    expect(await findRole(t, { id: "r-ghost" })).toBeNull();
    expect(t.query).not.toHaveBeenCalled();
  });

  it("an email two accounts share names neither", async () => {
    await expect(
      findUser(
        tx([
          { id: "a", cognito_sub: null, role_id: null },
          { id: "b", cognito_sub: null, role_id: null },
        ]),
        "dup@x.test"
      )
    ).rejects.toThrow(/more than one/);
  });
});

describe("handleChangeUserRole", () => {
  it.each([
    /from users/,
    /from roles where name/,
    /from roles where id/,
    /role_permissions/,
  ])("throws, never changes, when %p cannot be read", async (failing) => {
    fakeData().answer = answerer(failing);
    await expect(
      handleChangeUserRole({ user_identifier: USER, new_role: "staff" }, admin)
    ).rejects.toThrow(/could not be read/);
    expect(updates()).toEqual([]);
    expect(fakeData().audit).toEqual([]);
  });

  it("refuses a user whose current role does not exist", async () => {
    const base = answerer();
    fakeData().answer = (sql) =>
      sql.startsWith("select id, name, is_default from roles where id") ? [] : base(sql);
    const res = await handleChangeUserRole(
      { user_identifier: USER, new_role: "staff" },
      admin
    );
    expect(res).toMatchObject({
      success: false,
      error: expect.stringMatching(/not found/),
    });
    expect(updates()).toEqual([]);
  });

  it("returns a failed update as a failure, recorded as failed", async () => {
    const base = answerer();
    fakeData().answer = (sql, values) => {
      if (sql.startsWith("update users")) throw new Error("write refused");
      return base(sql, values);
    };
    const res = await handleChangeUserRole(
      { user_identifier: USER, new_role: "staff" },
      admin
    );
    expect(res).toMatchObject({
      success: false,
      error: "The change could not be saved: the database is unavailable or refused it.",
    });
    expect(JSON.stringify(res)).not.toContain("write refused");
    expect(fakeData().audit.map((r) => r.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
  });
});

const req = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...authAs("super_admin") },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("PATCH /api/admin/users", () => {
  it.each([/from users/, /from roles where id/, /role_permissions/])(
    "answers 503 and changes nothing when %p cannot be read",
    async (failing) => {
      fakeData().answer = answerer(failing);
      const res = await usersPATCH(
        req("/api/admin/users", "PATCH", { userId: USER, roleId: ROLE_NEW })
      );
      expect(res.status).toBe(503);
      expect(updates()).toEqual([]);
    }
  );

  it("refuses a user whose current role does not exist (404)", async () => {
    const base = answerer();
    fakeData().answer = (sql, values) =>
      sql.startsWith("select id, name, is_default from roles where id") &&
      values[0] === ROLE_OPS
        ? []
        : sql.startsWith("select id, name, is_default from roles where id")
          ? [{ id: ROLE_NEW, name: "staff" }]
          : base(sql, values);
    const res = await usersPATCH(
      req("/api/admin/users", "PATCH", { userId: USER, roleId: ROLE_NEW })
    );
    expect(res.status).toBe(404);
    expect(updates()).toEqual([]);
  });

  it("answers 500 when the update fails, recording the attempt as failed", async () => {
    const base = answerer();
    fakeData().answer = (sql, values) => {
      if (sql.startsWith("update users")) throw new Error("write refused");
      return base(sql, values);
    };
    const res = await usersPATCH(
      req("/api/admin/users", "PATCH", { userId: USER, roleId: ROLE_NEW })
    );
    expect(res.status).toBe(500);
    expect(fakeData().audit.map((r) => r.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
    expect(fakeData().audit[0].actor_id).toBe(CALLERS.super_admin.userId);
  });
});

describe("PATCH /api/admin/entitlements", () => {
  it.each([/from entitlement_groups/, /from entitlement_permissions/])(
    "answers 503 and changes nothing when %p cannot be read",
    async (failing) => {
      fakeData().answer = (sql) => {
        if (failing.test(sql)) throw new Error("relation unavailable");
        if (sql.startsWith("select id, code from entitlement_groups"))
          return [{ id: GROUP, code: "g" }];
        return [];
      };
      const res = await entPATCH(
        req("/api/admin/entitlements", "PATCH", { groupId: GROUP, isActive: true })
      );
      expect(res.status).toBe(503);
      expect(updates()).toEqual([]);
      expect(fakeData().audit).toEqual([]);
    }
  );
});

describe("list routes answer 500 when the database refuses the read", () => {
  it.each([
    ["/api/admin/users", usersGET],
    ["/api/admin/users?q=ali", usersGET],
    ["/api/admin/audit", auditGET],
    ["/api/admin/audit?q=00000000-0000-4000-8000-00000000b001", auditGET],
    ["/api/admin/audit?q=role", auditGET],
    ["/api/admin/roles", rolesGET],
    ["/api/admin/per-account", perAccountGET],
    ["/api/admin/entitlements", entGET],
  ])("%s", async (path, route) => {
    fakeData().answer = () => {
      throw new Error("down");
    };
    expect((await route(req(path))).status).toBe(500);
  });

  it("the entitlement list still answers when only the holder counts are unreadable", async () => {
    fakeData().answer = (sql) => {
      if (sql.includes("from user_entitlements")) throw new Error("down");
      return [{ id: GROUP, code: "g", display_name: "G", is_active: true }];
    };
    const res = await entGET(req("/api/admin/entitlements"));
    expect(res.status).toBe(200);
    expect((await res.json()).groups[0].userCount).toBe(0);
  });
});
