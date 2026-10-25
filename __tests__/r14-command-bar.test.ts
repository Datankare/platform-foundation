/**
 * __tests__/r14-command-bar.test.ts — Review 14 L-2: the roles command bar and a lost commit
 *
 * A role change commits its own transaction. When that commit's answer is lost with the
 * connection (it may have landed) the change is reported `indeterminate` — never "failed" — the
 * audit says so, and the user's permissions are invalidated all the same: a role that did change
 * must not be served from another instance's cache as it was.
 *
 * platform/data is a fake (helpers/fake-data.ts) whose update fails as a lost commit does.
 */
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { fakeData } from "./helpers/fake-data";
import { handleChangeUserRole } from "@/app/api/admin/ai/handlers/roles";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const USER = "00000000-0000-4000-8000-00000000b014";
const ROLE_OPS = "00000000-0000-4000-8000-000000000001";
const ROLE_NEW = "00000000-0000-4000-8000-000000000002";
const admin: VerifiedAdmin = {
  userId: "00000000-0000-4000-8000-00000000a014",
  sub: "sub-admin",
  roleName: "admin",
  permissions: ["admin_manage_users", "can_play"],
};

function answerer(update: () => unknown[] | undefined) {
  return (sql: string, values: readonly unknown[] = []): unknown[] | undefined => {
    if (/from platform_config/.test(sql) && values[0] === "admin.dual_control_actions") {
      return [{ value: [] }];
    }
    if (sql.startsWith("select id, cognito_sub, role_id from users")) {
      return [{ id: USER, cognito_sub: "sub-u14", role_id: ROLE_OPS }];
    }
    if (sql.startsWith("select id, name, is_default from roles where name")) {
      return [{ id: ROLE_NEW, name: "staff" }];
    }
    if (sql.startsWith("select id, name, is_default from roles where id")) {
      return [{ id: ROLE_OPS, name: "ops" }];
    }
    if (sql.startsWith("select p.code from permissions p")) return [{ code: "can_play" }];
    if (sql.startsWith("update users set role_id")) return update();
    return undefined;
  };
}

beforeEach(() => {
  fakeData().reset();
  (invalidatePermissions as jest.Mock).mockClear();
});

describe("R14-L2 a role change whose commit is lost", () => {
  it("answers indeterminate, is audited indeterminate, and invalidates the user's permissions", async () => {
    fakeData().answer = answerer(() => {
      // As platform/data's CommitOutcomeUnknownError: a DataUnavailableError, indeterminate.
      throw Object.assign(new Error("connection lost while committing"), {
        code: "data.unavailable",
        indeterminate: true,
      });
    });
    const res = await handleChangeUserRole(
      { user_identifier: USER, new_role: "staff" },
      admin
    );
    expect(res).toMatchObject({ success: false, indeterminate: true });
    expect(res.error).toMatch(/may or may not have been applied/);
    expect(fakeData().audit.map((a) => a.details.outcome)).toEqual([
      "attempted",
      "indeterminate",
    ]);
    expect(invalidatePermissions).toHaveBeenCalledWith("sub-u14");
  });

  it("a refused write is failed, and invalidates nothing", async () => {
    fakeData().answer = answerer(() => {
      throw Object.assign(new Error("permission denied"), { code: "42501" });
    });
    const res = await handleChangeUserRole(
      { user_identifier: USER, new_role: "staff" },
      admin
    );
    expect(res).toMatchObject({ success: false });
    expect(res.indeterminate).toBeUndefined();
    expect(fakeData().audit.map((a) => a.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
    expect(invalidatePermissions).not.toHaveBeenCalled();
  });

  it("a change that committed invalidates (unchanged)", async () => {
    fakeData().answer = answerer(() => []);
    const res = await handleChangeUserRole(
      { user_identifier: USER, new_role: "staff" },
      admin
    );
    expect(res.success).toBe(true);
    expect(invalidatePermissions).toHaveBeenCalledWith("sub-u14");
  });
});

describe("R14-M1 the 30 s bound is the DB tests' only", () => {
  it("a unit test outside __tests__/db keeps jest's default bound (jest.setup.ts selects by path)", () => {
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for("TEST_TIMEOUT_SYMBOL")]
    ).toBeUndefined();
  });
});
