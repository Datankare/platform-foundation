/**
 * __tests__/admin-ai-roles-handlers.test.ts — coverage remediation (ADR-040 "B", B3a).
 *
 * The ai command-bar role/permission/user-role action handlers (handlers/roles.ts).
 * Each is handle*(input, actorId) -> ActionResult; covers success, not-found, error,
 * and the conditional permission add/remove and user-assignment branches.
 */
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/platform/auth/audit", () => ({ writeAuditLog: jest.fn() }));
jest.mock("@/platform/auth/permissions-cache", () => ({
  invalidatePermissions: jest.fn(),
}));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import {
  handleCreateRole,
  handleDeleteRole,
  handleDuplicateRole,
  handleAssignPermissions,
  handleChangeUserRole,
} from "@/app/api/admin/ai/handlers/roles";

const mockSupabase = getSupabaseServiceClient as jest.Mock;

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

beforeEach(() => jest.clearAllMocks());

describe("handleCreateRole", () => {
  it("creates a role and attaches permissions", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        roles: { data: { id: "r1" }, error: null },
        permissions: { data: [{ id: "p1", code: "can_x" }] },
        role_permissions: { data: null },
      })
    );
    const res = await handleCreateRole(
      { name: "ops", display_name: "Ops", permissions: ["can_x"] },
      "admin-1"
    );
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/1 permissions/);
  });

  it("creates a role with no permissions", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ roles: { data: { id: "r1" }, error: null } })
    );
    const res = await handleCreateRole({ name: "ops", display_name: "Ops" }, "admin-1");
    expect(res.success).toBe(true);
  });

  it("returns the error when the insert fails", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ roles: { data: null, error: { message: "duplicate" } } })
    );
    const res = await handleCreateRole({ name: "ops", display_name: "Ops" }, "admin-1");
    expect(res.success).toBe(false);
    expect(res.error).toBe("duplicate");
  });
});

describe("handleDeleteRole", () => {
  it("deletes an unused role", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        roles: { data: { id: "r1" } },
        users: { count: 0 },
        role_permissions: { data: null },
      })
    );
    const res = await handleDeleteRole({ role_name: "ops" }, "admin-1");
    expect(res.success).toBe(true);
  });

  it("refuses when the role is not found", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ roles: { data: null } }));
    const res = await handleDeleteRole({ role_name: "ghost" }, "admin-1");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it("refuses when users are still assigned", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ roles: { data: { id: "r1" } }, users: { count: 3 } })
    );
    const res = await handleDeleteRole({ role_name: "ops" }, "admin-1");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/users assigned/);
  });
});

describe("handleDuplicateRole", () => {
  it("duplicates a role and copies permissions", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        roles: { data: { id: "r2" }, error: null },
        role_permissions: { data: [{ permission_id: "p1" }] },
      })
    );
    const res = await handleDuplicateRole(
      { source_role: "ops", new_name: "ops2", new_display_name: "Ops 2" },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("refuses when the source role is missing", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ roles: { data: null } }));
    const res = await handleDuplicateRole(
      { source_role: "ghost", new_name: "x", new_display_name: "X" },
      "admin-1"
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});

describe("handleAssignPermissions", () => {
  it("adds and removes permissions", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        roles: { data: { id: "r1" } },
        permissions: { data: [{ id: "p1" }] },
        role_permissions: { data: null },
      })
    );
    const res = await handleAssignPermissions(
      { role_name: "ops", add: ["can_x"], remove: ["can_y"] },
      "admin-1"
    );
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/\+1, -1/);
  });

  it("refuses when the role is not found", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ roles: { data: null } }));
    const res = await handleAssignPermissions({ role_name: "ghost", add: [] }, "admin-1");
    expect(res.success).toBe(false);
  });
});

describe("handleChangeUserRole", () => {
  it("assigns a user to a role", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({ roles: { data: { id: "r1" } }, users: { error: null } })
    );
    const res = await handleChangeUserRole(
      { user_identifier: "u@x.com", new_role: "ops" },
      "admin-1"
    );
    expect(res.success).toBe(true);
  });

  it("refuses when the target role is missing", async () => {
    mockSupabase.mockReturnValue(makeSupabase({ roles: { data: null } }));
    const res = await handleChangeUserRole(
      { user_identifier: "u@x.com", new_role: "ghost" },
      "admin-1"
    );
    expect(res.success).toBe(false);
  });

  it("returns the error when the update fails", async () => {
    mockSupabase.mockReturnValue(
      makeSupabase({
        roles: { data: { id: "r1" } },
        users: { error: { message: "nope" } },
      })
    );
    const res = await handleChangeUserRole(
      { user_identifier: "u@x.com", new_role: "ops" },
      "admin-1"
    );
    expect(res.success).toBe(false);
    expect(res.error).toBe("nope");
  });
});
