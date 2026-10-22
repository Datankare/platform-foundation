/**
 * __tests__/admin-ai-roles-handlers.test.ts — command-bar role, permission and user-role handlers
 *
 * Each handler is handle*(input, admin) -> ActionResult. Runs against an in-memory database
 * (helpers/fake-database.ts), so each test asserts what was written — including the audit record,
 * written by the real audit module before the change — and, for the hostile cases (TASK-145),
 * that a refused action wrote nothing.
 */
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/platform/auth/permissions-cache", () => ({
  invalidatePermissions: jest.fn(),
}));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import {
  handleCreateRole,
  handleDeleteRole,
  handleDuplicateRole,
  handleAssignPermissions,
  handleChangeUserRole,
} from "@/app/api/admin/ai/handlers/roles";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { FakeDatabase } from "./helpers/fake-database";

const ADMIN_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-00000000b001";

/** An admin holding the role-management permissions plus can_x and can_y — not can_secret. */
const admin: VerifiedAdmin = {
  userId: ADMIN_ID,
  sub: "sub-admin",
  roleName: "admin",
  permissions: ["admin_manage_roles", "admin_manage_users", "can_x", "can_y"],
};

let db: FakeDatabase;

beforeEach(() => {
  jest.clearAllMocks();
  db = new FakeDatabase(
    {
      permissions: [
        { id: "p-x", code: "can_x" },
        { id: "p-y", code: "can_y" },
        { id: "p-secret", code: "can_secret" },
      ],
      roles: [
        { id: "r-ops", name: "ops", description: "Operations" },
        { id: "r-power", name: "power" },
        { id: "r-super", name: "super_admin" },
        { id: "r-staff", name: "staff" },
      ],
      role_permissions: [
        { role_id: "r-ops", permission_id: "p-x" },
        { role_id: "r-power", permission_id: "p-secret" },
      ],
      users: [
        {
          id: USER_ID,
          email: "u@x.com",
          cognito_sub: "sub-u",
          role_id: "r-ops",
          deleted_at: null,
        },
        {
          id: ADMIN_ID,
          email: "a@x.com",
          cognito_sub: "sub-admin",
          role_id: "r-staff",
          deleted_at: null,
        },
        {
          id: "00000000-0000-4000-8000-00000000b002",
          email: "gone@x.com",
          cognito_sub: "sub-g",
          role_id: "r-ops",
          deleted_at: "2026-01-01",
        },
      ],
    },
    { unique: { roles: [["name"]] } }
  );
  (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
});

const roleNamed = (name: string) => db.rows("roles").find((r) => r.name === name);
const permsOf = (roleId: string) =>
  db
    .rows("role_permissions")
    .filter((rp) => rp.role_id === roleId)
    .map((rp) => rp.permission_id);
const roleOfUser = (id: string) => db.rows("users").find((u) => u.id === id)?.role_id;

describe("handleCreateRole", () => {
  it("creates a role with the permissions the admin holds", async () => {
    const res = await handleCreateRole(
      { name: "support", display_name: "Support", permissions: ["can_x"] },
      admin
    );
    expect(res.success).toBe(true);
    expect(permsOf(roleNamed("support")!.id)).toEqual(["p-x"]);
    expect(db.rows("audit_log")).toEqual([
      expect.objectContaining({ action: "admin_action", actor_id: ADMIN_ID }),
    ]);
    expect(db.writes[0]).toEqual(["insert", "audit_log", 1]);
  });

  it("creates a role with no permissions", async () => {
    const res = await handleCreateRole(
      { name: "support", display_name: "Support" },
      admin
    );
    expect(res.success).toBe(true);
  });

  it("returns the database error when the name is taken", async () => {
    const res = await handleCreateRole({ name: "ops", display_name: "Ops" }, admin);
    expect(res.success).toBe(false);
  });

  it("refuses a permission the admin does not hold, and writes nothing", async () => {
    const res = await handleCreateRole(
      { name: "sneaky", display_name: "Sneaky", permissions: ["can_secret"] },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(roleNamed("sneaky")).toBeUndefined();
    expect(db.writes).toEqual([]);
  });

  it("refuses to create a protected role", async () => {
    const res = await handleCreateRole({ name: "super_admin", display_name: "X" }, admin);
    expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
    expect(db.writes).toEqual([]);
  });
});

describe("handleDeleteRole", () => {
  it("deletes an unused role and its permission links", async () => {
    await handleCreateRole(
      { name: "temp", display_name: "Temp", permissions: ["can_x"] },
      admin
    );
    const id = roleNamed("temp")!.id;
    const res = await handleDeleteRole({ role_name: "temp" }, admin);
    expect(res.success).toBe(true);
    expect(roleNamed("temp")).toBeUndefined();
    expect(permsOf(id)).toEqual([]);
  });

  it("refuses when the role is not found", async () => {
    const res = await handleDeleteRole({ role_name: "ghost" }, admin);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it("refuses when users are still assigned", async () => {
    const res = await handleDeleteRole({ role_name: "ops" }, admin);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/users assigned/);
    expect(roleNamed("ops")).toBeDefined();
  });

  it("refuses to delete a protected role", async () => {
    const res = await handleDeleteRole({ role_name: "super_admin" }, admin);
    expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
    expect(roleNamed("super_admin")).toBeDefined();
  });

  it("refuses to delete a role holding a permission the admin lacks", async () => {
    const res = await handleDeleteRole({ role_name: "power" }, admin);
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(roleNamed("power")).toBeDefined();
  });
});

describe("handleDuplicateRole", () => {
  it("duplicates a role and copies its permissions", async () => {
    const res = await handleDuplicateRole(
      { source_role: "ops", new_name: "ops2", new_display_name: "Ops 2" },
      admin
    );
    expect(res.success).toBe(true);
    expect(permsOf(roleNamed("ops2")!.id)).toEqual(["p-x"]);
  });

  it("refuses when the source role is missing", async () => {
    const res = await handleDuplicateRole(
      { source_role: "ghost", new_name: "x", new_display_name: "X" },
      admin
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it("refuses to copy permissions the admin does not hold", async () => {
    const res = await handleDuplicateRole(
      { source_role: "power", new_name: "power2", new_display_name: "P2" },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(roleNamed("power2")).toBeUndefined();
  });

  it("refuses to duplicate into a protected role name", async () => {
    const res = await handleDuplicateRole(
      { source_role: "ops", new_name: "super_admin", new_display_name: "S" },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
  });
});

describe("handleAssignPermissions", () => {
  it("adds and removes permissions", async () => {
    const res = await handleAssignPermissions(
      { role_name: "ops", add: ["can_y"], remove: ["can_x"] },
      admin
    );
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/\+1, -1/);
    expect(permsOf("r-ops")).toEqual(["p-y"]);
  });

  it("refuses when the role is not found", async () => {
    const res = await handleAssignPermissions({ role_name: "ghost", add: [] }, admin);
    expect(res.success).toBe(false);
  });

  it("refuses to add a permission the admin does not hold", async () => {
    const res = await handleAssignPermissions(
      { role_name: "ops", add: ["can_secret"] },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(permsOf("r-ops")).toEqual(["p-x"]);
  });

  it("refuses to remove a permission the admin does not hold", async () => {
    const res = await handleAssignPermissions(
      { role_name: "power", remove: ["can_secret"] },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(permsOf("r-power")).toEqual(["p-secret"]);
  });

  it("refuses to edit a protected role", async () => {
    const res = await handleAssignPermissions(
      { role_name: "super_admin", add: ["can_x"] },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
    expect(permsOf("r-super")).toEqual([]);
  });
});

describe("handleChangeUserRole", () => {
  it("assigns a user, found by email, to a role", async () => {
    const res = await handleChangeUserRole(
      { user_identifier: "u@x.com", new_role: "staff" },
      admin
    );
    expect(res.success).toBe(true);
    expect(roleOfUser(USER_ID)).toBe("r-staff");
    expect(invalidatePermissions).toHaveBeenCalledWith("sub-u");
    expect(db.rows("audit_log")[0]).toMatchObject({
      action: "role_changed",
      actor_id: ADMIN_ID,
      target_id: USER_ID,
    });
  });

  it("finds a user by exact id", async () => {
    const res = await handleChangeUserRole(
      { user_identifier: USER_ID, new_role: "staff" },
      admin
    );
    expect(res.success).toBe(true);
  });

  it("refuses when the target role is missing", async () => {
    const res = await handleChangeUserRole(
      { user_identifier: "u@x.com", new_role: "ghost" },
      admin
    );
    expect(res.success).toBe(false);
    expect(roleOfUser(USER_ID)).toBe("r-ops");
  });

  it("refuses a deleted user", async () => {
    const res = await handleChangeUserRole(
      { user_identifier: "gone@x.com", new_role: "staff" },
      admin
    );
    expect(res.success).toBe(false);
  });

  it("refuses to change the admin's own role", async () => {
    const res = await handleChangeUserRole(
      { user_identifier: "a@x.com", new_role: "ops" },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_self_change" });
    expect(roleOfUser(ADMIN_ID)).toBe("r-staff");
  });

  it("refuses to assign super_admin", async () => {
    const res = await handleChangeUserRole(
      { user_identifier: "u@x.com", new_role: "super_admin" },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_database_only" });
    expect(roleOfUser(USER_ID)).toBe("r-ops");
  });

  it("refuses to grant a role carrying a permission the admin lacks", async () => {
    const res = await handleChangeUserRole(
      { user_identifier: "u@x.com", new_role: "power" },
      admin
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(roleOfUser(USER_ID)).toBe("r-ops");
  });

  it.each([
    "u@x.com,role_id.neq.null",
    "*",
    "%",
    "id.neq.00000000-0000-0000-0000-000000000000",
    "",
  ])(
    "treats a crafted identifier %p as a literal and changes no one",
    async (identifier) => {
      const before = db.rows("users").map((u) => u.role_id);
      const res = await handleChangeUserRole(
        { user_identifier: identifier, new_role: "staff" },
        admin
      );
      expect(res.success).toBe(false);
      expect(db.rows("users").map((u) => u.role_id)).toEqual(before);
    }
  );
});

describe("when the audit log is unavailable (audit X-8)", () => {
  beforeEach(() => db.failWrites("audit_log"));

  it.each([
    [
      "create_role",
      () => handleCreateRole({ name: "support", display_name: "S" }, admin),
    ],
    [
      "delete_role",
      async () => {
        db.rows("roles").push({ id: "r-tmp", name: "tmp" });
        return handleDeleteRole({ role_name: "tmp" }, admin);
      },
    ],
    [
      "duplicate_role",
      () =>
        handleDuplicateRole(
          { source_role: "ops", new_name: "ops3", new_display_name: "O" },
          admin
        ),
    ],
    [
      "assign_permissions",
      () => handleAssignPermissions({ role_name: "ops", add: ["can_y"] }, admin),
    ],
    [
      "change_user_role",
      () =>
        handleChangeUserRole({ user_identifier: "u@x.com", new_role: "staff" }, admin),
    ],
  ])("%s changes nothing and says why", async (_label, run) => {
    const res = await run();
    expect(res).toMatchObject({ success: false, code: "service.unavailable" });
    // No handler write landed.
    expect(
      db.writes.filter(([op, table]) => table !== "audit_log" && op !== "select")
    ).toEqual([]);
  });
});

describe("read failures stop a role change (release review, Sprint 7X)", () => {
  it.each(["role_permissions", "roles", "users", "permissions"])(
    "throws, never changes, when %s cannot be read",
    async (table) => {
      db.failReads(table);
      await expect(
        handleChangeUserRole({ user_identifier: USER_ID, new_role: "ops" }, admin)
      ).rejects.toThrow(/could not be read/);
      expect(roleOfUser(USER_ID)).toBe("r-ops");
      expect(db.writes).toEqual([]);
    }
  );

  it("refuses a user whose current role does not exist", async () => {
    db.rows("users").find((u) => u.id === USER_ID)!.role_id = "r-missing";
    const res = await handleChangeUserRole(
      { user_identifier: USER_ID, new_role: "ops" },
      admin
    );
    expect(res.success).toBe(false);
    expect(db.writes).toEqual([]);
  });
});
