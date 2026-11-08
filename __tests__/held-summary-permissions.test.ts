/**
 * __tests__/held-summary-permissions.test.ts — what a held role or entitlement action grants and
 * takes away, for its approver (TASK-202, N-61)
 *
 * The command bar's summary of a held action named a role change's account and roles, never what
 * it gives: now each role action names its role and the permissions it grants or takes away —
 * only codes of the permission catalog (a value of the payload that is not one is never shown),
 * at most 100 — and an entitlement group's code and on/off. The SQL is the fake's
 * (helpers/fake-data); the reads' own SQL runs on Postgres in __tests__/db/approver-rules.db.test.ts.
 */
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
jest.mock("@/platform/auth/role-lookup", () => ({
  findRole: async (_tx: unknown, by: { id?: string; name?: string }) => {
    const roles: Record<string, { id: string; name: string; permissions: string[] }> = {
      free: { id: "r-free", name: "free", permissions: ["can_play", "can_translate"] },
      moderator: {
        id: "r-mod",
        name: "moderator",
        permissions: ["can_translate", "can_moderate", "can_access_admin"],
      },
    };
    const found = Object.values(roles).find((r) => r.id === by.id || r.name === by.name);
    return found ? { ...found, isDefault: false } : null;
  },
}));

import { fakeData } from "./helpers/fake-data";
import { heldActionSummary } from "@/app/api/admin/ai/held-summary";

const ID = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const CATALOG = [
  "can_play",
  "can_translate",
  "can_moderate",
  "can_access_admin",
  "admin_view_audit",
];

beforeEach(() => {
  fakeData().reset();
  fakeData().answer = (sql, values) => {
    if (sql.startsWith("select code from permissions"))
      return (values[0] as string[])
        .filter((c) => CATALOG.includes(c))
        .map((code) => ({ code }));
    if (sql.startsWith("select id, email, role_id from users where id"))
      return values[0] === ID
        ? [{ id: ID, email: "member@example.test", role_id: "r-free" }]
        : [];
    if (sql.includes("from entitlement_groups g"))
      return values[0] === GROUP
        ? [{ code: "pro", permissions: ["admin_view_audit"] }]
        : [];
    return undefined;
  };
});

describe("held role and entitlement actions say what they grant (N-61)", () => {
  it("a role change: the new role's permissions the account's lacks, and those it loses", async () => {
    expect(
      await heldActionSummary("change_user_role", {
        user_identifier: ID,
        new_role: "moderator",
      })
    ).toEqual({
      target: { id: ID, email: "member@example.test" },
      fromRole: "free",
      toRole: "moderator",
      permissionsGranted: ["can_moderate", "can_access_admin"],
      permissionsRemoved: ["can_play"],
    });
  });

  it("a new role: its catalog permissions only — free text in the payload is never shown", async () => {
    expect(
      await heldActionSummary("create_role", {
        name: "qa",
        permissions: ["can_play", "<script>", "can_play", 7],
      })
    ).toEqual({ role: "qa", permissionsGranted: ["can_play"] });
  });

  it("permissions added to and removed from a role", async () => {
    expect(
      await heldActionSummary("assign_permissions", {
        role_name: "qa",
        add: ["admin_view_audit"],
        remove: ["can_play", "not_a_code"],
      })
    ).toEqual({
      role: "qa",
      permissionsGranted: ["admin_view_audit"],
      permissionsRemoved: ["can_play"],
    });
  });

  it("a copied role grants its source's permissions; a deleted role is named", async () => {
    expect(
      await heldActionSummary("duplicate_role", {
        source_role: "free",
        new_name: "free2",
      })
    ).toEqual({
      role: "free2",
      fromRole: "free",
      permissionsGranted: ["can_play", "can_translate"],
    });
    expect(await heldActionSummary("delete_role", { role_name: "qa" })).toEqual({
      role: "qa",
    });
    expect(await heldActionSummary("delete_role", {})).toBeUndefined();
  });

  it("an entitlement group: created with its permissions; turned on grants, off takes away", async () => {
    expect(
      await heldActionSummary("create_entitlement_group", {
        code: "pro",
        permissions: ["admin_view_audit"],
      })
    ).toEqual({ group: "pro", permissionsGranted: ["admin_view_audit"] });
    expect(
      await heldActionSummary("set_entitlement_group_active", {
        group_id: GROUP,
        is_active: true,
      })
    ).toEqual({ group: "pro", active: true, permissionsGranted: ["admin_view_audit"] });
    expect(
      await heldActionSummary("set_entitlement_group_active", {
        group_id: GROUP,
        is_active: false,
      })
    ).toEqual({ group: "pro", active: false, permissionsRemoved: ["admin_view_audit"] });
    // An id that is no group, or no id: nothing named.
    expect(
      await heldActionSummary("set_entitlement_group_active", {
        group_id: "x",
        is_active: true,
      })
    ).toEqual({ active: true });
  });

  it("a payload with no permission list grants nothing, and reads nothing", async () => {
    expect(
      await heldActionSummary("create_role", { name: "qa", permissions: "can_play" })
    ).toEqual({
      role: "qa",
    });
    expect(
      fakeData().statements.some((s) => s.sql.startsWith("select code from permissions"))
    ).toBe(false);
  });
});
