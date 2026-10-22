/**
 * platform/auth/__tests__/resolve-permissions.test.ts — what a user can actually do
 *
 * resolvePermissions against an in-memory database: role permissions, one level of role
 * inheritance, and entitlements — which grant only while not revoked, not expired and in an
 * active group (audit X-14: expired, revoked-by-deactivation and inactive grants kept granting).
 */

jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { resolvePermissions } from "@/platform/auth/permissions";
import { FakeDatabase, type Row } from "@/__tests__/helpers/fake-database";

const DAY = 86_400_000;
const future = new Date(Date.now() + DAY).toISOString();
const past = new Date(Date.now() - DAY).toISOString();

function setup(entitlements: Row[], groups: Row[] = [], userOverrides: Row = {}) {
  const db = new FakeDatabase({
    users: [
      {
        id: "u1",
        cognito_sub: "sub-1",
        role_id: "r-free",
        deleted_at: null,
        ...userOverrides,
      },
    ],
    roles: [
      { id: "r-free", name: "free" },
      { id: "r-base", name: "base" },
    ],
    role_inheritance: [{ role_id: "r-free", inherits_from_id: "r-base" }],
    permissions: [
      { id: "p-play", code: "can_play" },
      { id: "p-base", code: "can_base" },
      { id: "p-pro", code: "can_pro" },
      { id: "p-admin", code: "admin_manage_roles" },
    ],
    role_permissions: [
      { role_id: "r-free", permission_id: "p-play" },
      { role_id: "r-base", permission_id: "p-base" },
    ],
    entitlement_groups: [
      { id: "g-pro", code: "pro", is_active: true },
      { id: "g-off", code: "off", is_active: false },
      ...groups,
    ],
    entitlement_permissions: [
      { entitlement_group_id: "g-pro", permission_id: "p-pro" },
      { entitlement_group_id: "g-off", permission_id: "p-admin" },
    ],
    user_entitlements: entitlements.map((e) => ({
      user_id: "u1",
      revoked_at: null,
      ...e,
    })),
  });
  (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
}

const codes = async () => (await resolvePermissions("sub-1"))?.permissions.sort();

describe("resolvePermissions", () => {
  it("returns the role's permissions plus one level of inheritance", async () => {
    setup([]);
    expect(await codes()).toEqual(["can_base", "can_play"]);
  });

  it("returns null for an unknown or deleted user", async () => {
    setup([], [], { deleted_at: "2026-01-01" });
    await expect(resolvePermissions("sub-1")).resolves.toBeNull();
    await expect(resolvePermissions("sub-none")).resolves.toBeNull();
  });

  it("adds an active, unexpired entitlement's permissions and code", async () => {
    setup([{ entitlement_group_id: "g-pro", expires_at: future }]);
    const result = await resolvePermissions("sub-1");
    expect(result?.permissions).toContain("can_pro");
    expect(result?.entitlementGroups).toEqual(["pro"]);
  });

  it("adds an entitlement with no expiry", async () => {
    setup([{ entitlement_group_id: "g-pro", expires_at: null }]);
    expect(await codes()).toContain("can_pro");
  });

  it.each([
    ["expired", { entitlement_group_id: "g-pro", expires_at: past }],
    ["revoked", { entitlement_group_id: "g-pro", expires_at: null, revoked_at: past }],
    ["with an unreadable expiry", { entitlement_group_id: "g-pro", expires_at: "soon" }],
  ])("ignores an entitlement that is %s", async (_label, grant) => {
    setup([grant]);
    expect(await codes()).not.toContain("can_pro");
  });

  it("ignores an inactive group's permissions entirely (X-14)", async () => {
    setup([{ entitlement_group_id: "g-off", expires_at: null }]);
    const result = await resolvePermissions("sub-1");
    expect(result?.permissions).not.toContain("admin_manage_roles");
    expect(result?.entitlementGroups).toEqual([]);
  });

  it("grants from the active group but not the inactive one when both are held", async () => {
    setup([
      { entitlement_group_id: "g-pro", expires_at: null },
      { entitlement_group_id: "g-off", expires_at: null },
    ]);
    const result = await resolvePermissions("sub-1");
    expect(result?.permissions).toContain("can_pro");
    expect(result?.permissions).not.toContain("admin_manage_roles");
  });

  it("does not take another user's entitlements", async () => {
    setup([{ entitlement_group_id: "g-pro", expires_at: null, user_id: "u2" }]);
    expect(await codes()).not.toContain("can_pro");
  });
});
