/**
 * @jest-environment node
 */
/**
 * The shared role and entitlement catalog, changed through the admin command bar and the
 * entitlements route, on Postgres (ADR-053 D5, TASK-145)
 *
 * The catalog — roles, role_permissions, permissions, entitlement_groups, entitlement_permissions
 * — is shared by every tenant and read-only to the request role. A change to it is allowed only
 * when mayChangePlatformCatalog(admin): a single-tenant deployment's administrators, a shared
 * deployment's operators (platform_operate); anyone else gets `admin.operator_only` and nothing
 * is written. Every existing role rule still applies, each change is recorded before it is made
 * (no record, no change), and multi-step changes are one transaction.
 *
 * Every catalog row this suite touches is its own (random names, helpers/db-admin.ts
 * createCatalog), removed afterwards; seeded rows are only read.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));
jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/db-admin").mockTenantMiddleware()
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
/**
 * The entitlement toggle's direct-change cases have it off the dual-control list (an operator's
 * governed choice) — for this suite only, through the route's reading of the list; the shared
 * configuration row is never changed (suites run in parallel against one database).
 */
const mockDualControl = { off: true };
jest.mock("@/app/api/admin/ai/command-bar", () => {
  const actual = jest.requireActual("@/app/api/admin/ai/command-bar");
  return {
    ...actual,
    isDualControlledAction: jest.fn(async (tool: string) =>
      mockDualControl.off ? false : actual.isDualControlledAction(tool)
    ),
  };
});

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { withOwnerTx } from "@/platform/data";
import { runWithTenant } from "@/platform/tenancy/context";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import {
  handleAssignPermissions,
  handleCreateRole,
  handleDeleteRole,
  handleDuplicateRole,
} from "@/app/api/admin/ai/handlers/roles";
import {
  handleCreateEntitlementGroup,
  handleSetEntitlementGroupActive,
} from "@/app/api/admin/ai/handlers/entitlements";
import { DEFAULT_DUAL_CONTROL_ACTIONS } from "@/app/api/admin/ai/command-bar";
import { GET as rolesGET } from "@/app/api/admin/roles/route";
import { GET as entGET, PATCH as entPATCH } from "@/app/api/admin/entitlements/route";
import {
  DB_ENABLED,
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import {
  asCallerIn,
  callerWithUnrecordableId,
  catalogName,
  createCatalog,
  dropCatalog,
  insertUser,
  newRun,
  seededRoleId,
  suiteCaller,
  type TestCatalog,
} from "../helpers/db-admin";
import type { TestIdentity } from "../helpers/test-identities";

const RUN = newRun();
const name = (label: string) => catalogName(RUN, label);

let a: TestTenant;
let b: TestTenant;
let cat: TestCatalog;

/** Tenant administrators of a shared deployment: the role permissions, no platform_operate. */
let tenantAdmin: VerifiedAdmin;
/** The same, as an operator. */
let operator: VerifiedAdmin;

const shared = <T>(fn: () => Promise<T>) => a.run(fn);
const single = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: a.id, mode: "single" }, fn);

async function q<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<R[]> {
  return (await withOwnerTx("operator", (tx) => tx.query<R>(text, values))).rows;
}
const roleNamed = async (n: string) =>
  (await q<{ id: string }>("select id from roles where name = $1", [n]))[0];
const permsOf = async (roleId: string) =>
  (
    await q<{ code: string }>(
      `select p.code from role_permissions rp join permissions p on p.id = rp.permission_id
        where rp.role_id = $1::uuid order by p.code`,
      [roleId]
    )
  ).map((r) => r.code);
const auditOf = (t: TestTenant) =>
  q<{ action: string; actor_id: string | null; details: Record<string, unknown> }>(
    "select action, actor_id, details from audit_log where tenant_id = $1::uuid order by created_at, id",
    [t.id]
  );

const SUITE = "the shared catalog, changed by admins (ADR-053 D5)";

// Once per file, as before; nothing connects when the database is absent.
if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    cat = await createCatalog(RUN, {
      permissions: ["x", "y", "secret"],
      roles: { ops: ["x"], power: ["secret"], staff: [], spare: ["x"] },
      groups: {
        basic: { permissions: ["can_play"] },
        mighty: { permissions: ["admin_manage_roles"] },
      },
    });
    const perms = [
      "admin_manage_roles",
      "admin_manage_entitlements",
      cat.codes.x,
      cat.codes.y,
    ];
    tenantAdmin = {
      userId: randomUUID(),
      sub: `sub-${RUN}`,
      roleName: "admin",
      permissions: perms,
    };
    operator = { ...tenantAdmin, permissions: [...perms, "platform_operate"] };
    await insertUser(a, { roleId: cat.roles.ops, email: `u-${RUN}@x.test` });
    // A holder of `spare` in another tenant: a role in use anywhere is not deleted.
    await insertUser(b, { roleId: cat.roles.spare });
  });
  afterAll(async () => {
    await dropTestTenants();
    await dropCatalog();
    await disconnectTestDatabase();
  });
}

dbDescribe(`${SUITE} handleCreateRole`, () => {
  it("records, then creates a role with the permissions the admin holds", async () => {
    const before = (await auditOf(a)).length;
    const res = await shared(() =>
      handleCreateRole(
        { name: name("support"), display_name: "Support", permissions: [cat.codes.x] },
        operator
      )
    );
    expect(res.success).toBe(true);
    expect(await permsOf((await roleNamed(name("support"))).id)).toEqual([cat.codes.x]);
    const audit = (await auditOf(a)).slice(before);
    expect(audit[0]).toMatchObject({
      action: "admin_action",
      actor_id: operator.userId,
      details: expect.objectContaining({ type: "create_role", outcome: "attempted" }),
    });
  });

  it("creates a role with no permissions", async () => {
    const res = await shared(() =>
      handleCreateRole({ name: name("bare"), display_name: "Bare" }, operator)
    );
    expect(res.success).toBe(true);
    expect(await permsOf((await roleNamed(name("bare"))).id)).toEqual([]);
  });

  it("says a taken name plainly, never with the database's own message", async () => {
    const res = await shared(() =>
      handleCreateRole({ name: cat.roleNames.ops, display_name: "Ops" }, operator)
    );
    expect(res.success).toBe(false);
    expect(res.error).toBe("That already exists: choose another name.");
    expect(res.error).not.toMatch(/duplicate|unique|constraint/i);
  });

  it("refuses a permission the admin does not hold, and writes nothing", async () => {
    const before = (await auditOf(a)).length;
    const res = await shared(() =>
      handleCreateRole(
        { name: name("sneaky"), display_name: "S", permissions: [cat.codes.secret] },
        operator
      )
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(await roleNamed(name("sneaky"))).toBeUndefined();
    expect(await auditOf(a)).toHaveLength(before);
  });

  it("refuses to create a protected role", async () => {
    const res = await shared(() =>
      handleCreateRole({ name: "super_admin", display_name: "X" }, operator)
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
  });
});

dbDescribe(`${SUITE} handleDeleteRole`, () => {
  it("deletes an unused role and its permission links", async () => {
    await shared(() =>
      handleCreateRole(
        { name: name("temp"), display_name: "Temp", permissions: [cat.codes.x] },
        operator
      )
    );
    const id = (await roleNamed(name("temp"))).id;
    const res = await shared(() =>
      handleDeleteRole({ role_name: name("temp") }, operator)
    );
    expect(res.success).toBe(true);
    expect(await roleNamed(name("temp"))).toBeUndefined();
    expect(await permsOf(id)).toEqual([]);
  });

  it("refuses when the role is not found", async () => {
    const res = await shared(() =>
      handleDeleteRole({ role_name: name("ghost") }, operator)
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it("refuses when users are still assigned", async () => {
    const res = await shared(() =>
      handleDeleteRole({ role_name: cat.roleNames.ops }, operator)
    );
    expect(res.error).toMatch(/1 users assigned/);
    expect(await roleNamed(cat.roleNames.ops)).toBeDefined();
  });

  it("counts holders in every tenant: a role another tenant uses stays", async () => {
    const res = await shared(() =>
      handleDeleteRole({ role_name: cat.roleNames.spare }, operator)
    );
    expect(res.error).toMatch(/users assigned/);
    expect(await roleNamed(cat.roleNames.spare)).toBeDefined();
  });

  it("refuses to delete a protected role", async () => {
    const res = await shared(() =>
      handleDeleteRole({ role_name: "super_admin" }, operator)
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
    expect(await roleNamed("super_admin")).toBeDefined();
  });

  it("refuses to delete a role holding a permission the admin lacks", async () => {
    const res = await shared(() =>
      handleDeleteRole({ role_name: cat.roleNames.power }, operator)
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(await roleNamed(cat.roleNames.power)).toBeDefined();
  });
});

dbDescribe(`${SUITE} handleDuplicateRole`, () => {
  it("duplicates a role and copies its permissions", async () => {
    const res = await shared(() =>
      handleDuplicateRole(
        {
          source_role: cat.roleNames.ops,
          new_name: name("ops2"),
          new_display_name: "O2",
        },
        operator
      )
    );
    expect(res).toMatchObject({ success: true });
    expect(res.result).toMatch(/with 1 permissions/);
    const copy = await roleNamed(name("ops2"));
    expect(await permsOf(copy.id)).toEqual([cat.codes.x]);
    const [row] = await q<{ description: string }>(
      "select description from roles where id = $1::uuid",
      [copy.id]
    );
    expect(row.description).toBe(`Duplicated from ${cat.roleNames.ops}. Test role ops`);
  });

  it("refuses when the source role is missing", async () => {
    const res = await shared(() =>
      handleDuplicateRole(
        { source_role: name("ghost"), new_name: name("g2"), new_display_name: "G" },
        operator
      )
    );
    expect(res.error).toMatch(/not found/);
  });

  it("refuses to copy permissions the admin does not hold", async () => {
    const res = await shared(() =>
      handleDuplicateRole(
        {
          source_role: cat.roleNames.power,
          new_name: name("p2"),
          new_display_name: "P",
        },
        operator
      )
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(await roleNamed(name("p2"))).toBeUndefined();
  });

  it("refuses to duplicate into a protected role name", async () => {
    const res = await shared(() =>
      handleDuplicateRole(
        {
          source_role: cat.roleNames.ops,
          new_name: "super_admin",
          new_display_name: "S",
        },
        operator
      )
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
  });
});

dbDescribe(
  `${SUITE} protected power is not copied or given away (audit B-12, RR-15)`,
  () => {
    /** An operator who holds every permission there is (as super_admin does). */
    const everything = async (): Promise<VerifiedAdmin> => ({
      ...operator,
      permissions: (await q<{ code: string }>("select code from permissions")).map(
        (r) => r.code
      ),
    });

    it("refuses to duplicate a protected role, even for an admin who holds all it holds", async () => {
      const res = await shared(async () =>
        handleDuplicateRole(
          { source_role: "super_admin", new_name: name("root2"), new_display_name: "R" },
          await everything()
        )
      );
      expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
      expect(await roleNamed(name("root2"))).toBeUndefined();
    });

    it.each([
      "can_access_admin",
      "admin_manage_roles",
      "config_manage_safety",
      "can_moderate",
    ])("refuses %s on the default role every new account gets", async (permission) => {
      const freeId = await seededRoleId("free");
      const before = await permsOf(freeId);
      const res = await shared(async () =>
        handleAssignPermissions(
          { role_name: "free", add: [permission] },
          await everything()
        )
      );
      expect(res).toMatchObject({ success: false, code: "auth.default_role_limited" });
      expect(await permsOf(freeId)).toEqual(before);
    });

    it("judges a role by the permissions it inherits, not only its own (RR-15)", async () => {
      await shared(() =>
        handleCreateRole(
          { name: name("heir"), display_name: "Heir", permissions: [cat.codes.x] },
          operator
        )
      );
      const heir = (await roleNamed(name("heir"))).id;
      // No API path creates inheritance; the database may hold it.
      await q(
        "insert into role_inheritance (role_id, inherits_from_id) values ($1::uuid, $2::uuid)",
        [heir, cat.roles.power]
      );
      // The operator lacks `secret`, which the heir holds through inheritance.
      const res = await shared(() =>
        handleDeleteRole({ role_name: name("heir") }, operator)
      );
      expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
      expect(await roleNamed(name("heir"))).toBeDefined();
    });
  }
);

dbDescribe(`${SUITE} handleAssignPermissions`, () => {
  it("adds and removes permissions together", async () => {
    await shared(() =>
      handleCreateRole(
        { name: name("assign"), display_name: "A", permissions: [cat.codes.x] },
        operator
      )
    );
    const id = (await roleNamed(name("assign"))).id;
    const res = await shared(() =>
      handleAssignPermissions(
        { role_name: name("assign"), add: [cat.codes.y], remove: [cat.codes.x] },
        operator
      )
    );
    expect(res.success).toBe(true);
    expect(res.result).toMatch(/\+1, -1/);
    expect(await permsOf(id)).toEqual([cat.codes.y]);
    // Re-adding a permission the role holds is a no-op.
    const again = await shared(() =>
      handleAssignPermissions({ role_name: name("assign"), add: [cat.codes.y] }, operator)
    );
    expect(again.success).toBe(true);
    expect(await permsOf(id)).toEqual([cat.codes.y]);
  });

  it("refuses when the role is not found", async () => {
    const res = await shared(() =>
      handleAssignPermissions({ role_name: name("ghost"), add: [] }, operator)
    );
    expect(res.success).toBe(false);
  });

  it("refuses to add a permission the admin does not hold", async () => {
    const res = await shared(() =>
      handleAssignPermissions(
        { role_name: cat.roleNames.ops, add: [cat.codes.secret] },
        operator
      )
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(await permsOf(cat.roles.ops)).toEqual([cat.codes.x]);
  });

  it("refuses to remove a permission the admin does not hold", async () => {
    const res = await shared(() =>
      handleAssignPermissions(
        { role_name: cat.roleNames.power, remove: [cat.codes.secret] },
        operator
      )
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(await permsOf(cat.roles.power)).toEqual([cat.codes.secret]);
  });

  it("refuses to edit a protected role", async () => {
    const superId = await seededRoleId("super_admin");
    const before = await permsOf(superId);
    const res = await shared(() =>
      handleAssignPermissions({ role_name: "super_admin", add: [cat.codes.x] }, operator)
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_protected" });
    expect(await permsOf(superId)).toEqual(before);
  });
});

dbDescribe(`${SUITE} handleCreateEntitlementGroup`, () => {
  it("creates a group with its permissions, in one transaction", async () => {
    const res = await shared(() =>
      handleCreateEntitlementGroup(
        { code: name("pro"), display_name: "Pro", permissions: [cat.codes.x] },
        operator
      )
    );
    expect(res.success).toBe(true);
    const rows = await q<{ code: string; is_active: boolean }>(
      `select p.code, g.is_active from entitlement_groups g
           join entitlement_permissions ep on ep.entitlement_group_id = g.id
           join permissions p on p.id = ep.permission_id
          where g.code = $1`,
      [name("pro")]
    );
    expect(rows).toEqual([{ code: cat.codes.x, is_active: true }]);
  });

  it("surfaces an insert error (a taken code)", async () => {
    const res = await shared(() =>
      handleCreateEntitlementGroup(
        { code: cat.groupCodes.basic, display_name: "Dup" },
        operator
      )
    );
    expect(res.success).toBe(false);
  });

  it("cannot carry a permission the admin lacks", async () => {
    const res = await shared(() =>
      handleCreateEntitlementGroup(
        { code: name("x"), display_name: "X", permissions: [cat.codes.secret] },
        operator
      )
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(
      await q("select 1 from entitlement_groups where code = $1", [name("x")])
    ).toHaveLength(0);
  });
});

dbDescribe(`${SUITE} who may change the catalog`, () => {
  const attempts: [string, (admin: VerifiedAdmin) => Promise<unknown>][] = [
    [
      "create_role",
      (admin) => handleCreateRole({ name: name("nope1"), display_name: "N" }, admin),
    ],
    [
      "delete_role",
      (admin) => handleDeleteRole({ role_name: cat.roleNames.staff }, admin),
    ],
    [
      "duplicate_role",
      (admin) =>
        handleDuplicateRole(
          {
            source_role: cat.roleNames.staff,
            new_name: name("nope2"),
            new_display_name: "N",
          },
          admin
        ),
    ],
    [
      "assign_permissions",
      (admin) =>
        handleAssignPermissions(
          { role_name: cat.roleNames.staff, add: [cat.codes.x] },
          admin
        ),
    ],
    [
      "create_entitlement_group",
      (admin) =>
        handleCreateEntitlementGroup({ code: name("nope3"), display_name: "N" }, admin),
    ],
  ];

  it.each(attempts)(
    "%s: refused to a tenant administrator of a shared deployment, writing nothing",
    async (_label, attempt) => {
      const before = (await auditOf(a)).length;
      const res = await shared(() => attempt(tenantAdmin));
      expect(res).toMatchObject({ success: false, code: "admin.operator_only" });
      expect(await auditOf(a)).toHaveLength(before);
      expect(await roleNamed(cat.roleNames.staff)).toBeDefined();
      expect(await permsOf(cat.roles.staff)).toEqual([]);
      expect(await roleNamed(name("nope1"))).toBeUndefined();
      expect(await roleNamed(name("nope2"))).toBeUndefined();
      expect(
        await q("select 1 from entitlement_groups where code = $1", [name("nope3")])
      ).toHaveLength(0);
    }
  );

  it("lets a single-tenant deployment's administrators change it, under the same rules", async () => {
    const created = await single(() =>
      handleCreateRole(
        { name: name("solo"), display_name: "Solo", permissions: [cat.codes.x] },
        tenantAdmin
      )
    );
    expect(created.success).toBe(true);
    const refused = await single(() =>
      handleCreateRole(
        { name: name("solo2"), display_name: "S", permissions: [cat.codes.secret] },
        tenantAdmin
      )
    );
    expect(refused).toMatchObject({ code: "auth.grant_exceeds_own" });
    const assigned = await single(() =>
      handleAssignPermissions(
        { role_name: name("solo"), add: [cat.codes.y] },
        tenantAdmin
      )
    );
    expect(assigned.success).toBe(true);
    const deleted = await single(() =>
      handleDeleteRole({ role_name: name("solo") }, tenantAdmin)
    );
    expect(deleted.success).toBe(true);
    expect(await roleNamed(name("solo"))).toBeUndefined();
  });
});

dbDescribe(`${SUITE} when the audit log is unavailable (audit X-8)`, () => {
  // An actor id the audit log refuses: every attempt finds it unavailable.
  const unrecorded = () => ({ ...operator, userId: `not-a-user-${RUN}` });

  it.each([
    [
      "create_role",
      () => handleCreateRole({ name: name("na1"), display_name: "N" }, unrecorded()),
    ],
    [
      "delete_role",
      () => handleDeleteRole({ role_name: cat.roleNames.staff }, unrecorded()),
    ],
    [
      "duplicate_role",
      () =>
        handleDuplicateRole(
          {
            source_role: cat.roleNames.ops,
            new_name: name("na2"),
            new_display_name: "N",
          },
          unrecorded()
        ),
    ],
    [
      "assign_permissions",
      () =>
        handleAssignPermissions(
          { role_name: cat.roleNames.staff, add: [cat.codes.y] },
          unrecorded()
        ),
    ],
    [
      "create_entitlement_group",
      () =>
        handleCreateEntitlementGroup(
          { code: name("na3"), display_name: "N" },
          unrecorded()
        ),
    ],
  ])("%s changes nothing and says why", async (_label, run) => {
    const res = await shared(run);
    expect(res).toMatchObject({ success: false, code: "service.unavailable" });
    expect(await roleNamed(cat.roleNames.staff)).toBeDefined();
    expect(await permsOf(cat.roles.staff)).toEqual([]);
    expect(await roleNamed(name("na1"))).toBeUndefined();
    expect(await roleNamed(name("na2"))).toBeUndefined();
    expect(
      await q("select 1 from entitlement_groups where code = $1", [name("na3")])
    ).toHaveLength(0);
  });
});

dbDescribe(`${SUITE} GET /api/admin/roles`, () => {
  it("lists the catalog with each role's permissions", async () => {
    const caller = suiteCaller("super_admin", RUN);
    const res = await rolesGET(
      new NextRequest("http://localhost/api/admin/roles", {
        headers: asCallerIn(caller, b),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ops = body.roles.find((r: { name: string }) => r.name === cat.roleNames.ops);
    expect(ops).toMatchObject({ permissionCount: 1, description: "Test role ops" });
    expect(ops.permissions[0].code).toBe(cat.codes.x);
    expect(typeof ops.createdAt).toBe("string");
    expect(
      body.roles.find((r: { name: string }) => r.name === cat.roleNames.staff)
        .permissionCount
    ).toBe(0);
    expect(
      body.availablePermissions.some((p: { code: string }) => p.code === cat.codes.y)
    ).toBe(true);
  });

  it("refuses a caller without the page's permission", async () => {
    const res = await rolesGET(
      new NextRequest("http://localhost/api/admin/roles", {
        headers: asCallerIn(suiteCaller("admin", RUN), a),
      })
    );
    expect(res.status).toBe(403);
  });
});

dbDescribe(`${SUITE} /api/admin/entitlements`, () => {
  let admin: TestIdentity;
  let superAdmin: TestIdentity;
  const isActive = async (id: string) =>
    (
      await q<{ is_active: boolean }>(
        "select is_active from entitlement_groups where id = $1::uuid",
        [id]
      )
    )[0].is_active;
  const req = (
    method: string,
    caller: Parameters<typeof asCallerIn>[0],
    body?: unknown,
    mode: "single" | "shared" = "shared",
    raw?: string
  ) =>
    new NextRequest("http://localhost/api/admin/entitlements", {
      method,
      headers: { "content-type": "application/json", ...asCallerIn(caller, a, mode) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });

  beforeAll(async () => {
    admin = suiteCaller("admin", RUN);
    superAdmin = suiteCaller("super_admin", RUN, { name: "ent-super" });
    const holder1 = await insertUser(a, { roleId: cat.roles.staff });
    const holder2 = await insertUser(a, { roleId: cat.roles.staff });
    const revoked = await insertUser(a, { roleId: cat.roles.staff });
    const other = await insertUser(b, { roleId: cat.roles.staff });
    await withOwnerTx("operator", async (tx) => {
      const grant = (
        t: TestTenant,
        user: string,
        group: string,
        revokedAt: string | null
      ) =>
        tx.query(
          `insert into user_entitlements (user_id, entitlement_group_id, revoked_at, tenant_id)
             values ($1::uuid, $2::uuid, $3::timestamptz, $4::uuid)`,
          [user, group, revokedAt, t.id]
        );
      await grant(a, holder1, cat.groups.basic, null);
      await grant(a, holder2, cat.groups.basic, null);
      await grant(a, revoked, cat.groups.mighty, "2026-01-01T00:00:00Z");
      await grant(b, other, cat.groups.basic, null);
    });
  });

  afterEach(async () => {
    await q(
      "update entitlement_groups set is_active = false where id = any($1::uuid[])",
      [[cat.groups.basic, cat.groups.mighty]]
    );
  });

  it("GET lists groups with this tenant's active holders only", async () => {
    const body = await (await entGET(req("GET", admin))).json();
    const basic = body.groups.find(
      (g: { code: string }) => g.code === cat.groupCodes.basic
    );
    const mighty = body.groups.find(
      (g: { code: string }) => g.code === cat.groupCodes.mighty
    );
    expect(basic).toMatchObject({ userCount: 2, isActive: false });
    expect(mighty.userCount).toBe(0);
  });

  it("PATCH is refused to a tenant administrator of a shared deployment", async () => {
    const res = await entPATCH(
      req("PATCH", admin, { groupId: cat.groups.basic, isActive: true })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("admin.operator_only");
    expect(await isActive(cat.groups.basic)).toBe(false);
  });

  it("PATCH lets a single-tenant administrator turn on a group whose permissions they hold", async () => {
    const before = (await auditOf(a)).length;
    const res = await entPATCH(
      req("PATCH", admin, { groupId: cat.groups.basic, isActive: true }, "single")
    );
    expect(res.status).toBe(200);
    expect(await isActive(cat.groups.basic)).toBe(true);
    expect((await auditOf(a)).slice(before)[0]).toMatchObject({
      actor_id: admin.userId,
      details: expect.objectContaining({ type: "entitlement_toggle", isActive: true }),
    });
  });

  it("PATCH refuses a group granting a permission the admin lacks (TASK-145)", async () => {
    const res = await entPATCH(
      req("PATCH", admin, { groupId: cat.groups.mighty, isActive: true }, "single")
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.grant_exceeds_own");
    expect(await isActive(cat.groups.mighty)).toBe(false);
  });

  it("PATCH lets an operator turn on that group in a shared deployment", async () => {
    const res = await entPATCH(
      req("PATCH", superAdmin, { groupId: cat.groups.mighty, isActive: true })
    );
    expect(res.status).toBe(200);
    expect(await isActive(cat.groups.mighty)).toBe(true);
  });

  it.each([randomUUID(), "g-none"])(
    "PATCH returns 404 for the unknown group %p",
    async (id) => {
      const res = await entPATCH(
        req("PATCH", superAdmin, { groupId: id, isActive: true })
      );
      expect(res.status).toBe(404);
    }
  );

  it.each([
    [{ isActive: true }],
    [{ groupId: "g", isActive: "true" }],
    [{ groupId: ["g"], isActive: true }],
  ])("PATCH returns 400 for %p", async (body) => {
    expect((await entPATCH(req("PATCH", superAdmin, body))).status).toBe(400);
  });

  it("PATCH returns 400 for a malformed body", async () => {
    expect(
      (await entPATCH(req("PATCH", superAdmin, undefined, "shared", "{x"))).status
    ).toBe(400);
  });

  it.each(["anonymous", "free", "moderator", "safety_approver"] as const)(
    "refuses %s",
    async (role) => {
      const caller = role === "anonymous" ? role : suiteCaller(role, RUN);
      const res = await entPATCH(
        req("PATCH", caller, { groupId: cat.groups.basic, isActive: true }, "single")
      );
      expect([401, 403]).toContain(res.status);
      expect(await isActive(cat.groups.basic)).toBe(false);
    }
  );

  it("refuses a suspended super_admin", async () => {
    const suspended = suiteCaller("super_admin", RUN, {
      name: "suspended",
      inGoodStanding: false,
    });
    const res = await entPATCH(
      req("PATCH", suspended, { groupId: cat.groups.basic, isActive: true })
    );
    expect(res.status).toBe(403);
    expect(await isActive(cat.groups.basic)).toBe(false);
  });

  it("does not toggle a group when the audit log is unavailable", async () => {
    const res = await entPATCH(
      req("PATCH", callerWithUnrecordableId("super_admin", RUN), {
        groupId: cat.groups.basic,
        isActive: true,
      })
    );
    expect(res.status).toBe(503);
    expect(await isActive(cat.groups.basic)).toBe(false);
  });

  /**
   * Review 7 M6: an entitlement group turned on or off is a change to who holds power — an active
   * group grants its permissions to everyone holding it — and is held for a second admin like a
   * role change, on the page and in the command bar.
   */
  describe("under dual control (review 7 M6)", () => {
    beforeAll(() => {
      mockDualControl.off = false;
    });
    afterAll(() => {
      mockDualControl.off = true;
    });
    afterEach(async () => {
      await q(
        "update entitlement_groups set is_active = false where id = any($1::uuid[])",
        [[cat.groups.basic, cat.groups.mighty]]
      );
    });

    it("the entitlement actions are on the seeded list; the capability mapping is held by its key, not the list (review 10 H1)", async () => {
      for (const tool of ["create_entitlement_group", "set_entitlement_group_active"])
        expect(DEFAULT_DUAL_CONTROL_ACTIONS).toContain(tool);
      expect(DEFAULT_DUAL_CONTROL_ACTIONS).not.toContain("set_capability_mapping");
      const [row] = await q<{ value: string[]; default_value: string[] }>(
        "select value, default_value from platform_config where key = 'admin.dual_control_actions'"
      );
      expect(row.default_value).toEqual([...DEFAULT_DUAL_CONTROL_ACTIONS]);
    });

    it("holds the toggle for a second admin, and changes nothing", async () => {
      const before = (await auditOf(a)).length;
      const res = await entPATCH(
        req("PATCH", admin, { groupId: cat.groups.basic, isActive: true }, "single")
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        held: true,
        proposalId: expect.any(String),
      });
      expect(await isActive(cat.groups.basic)).toBe(false);
      expect(
        (await auditOf(a))
          .slice(before)
          .filter((r) => r.details?.type === "entitlement_toggle")
      ).toEqual([]);
    });

    it("the held action, once approved, turns the group on under the page's rules", async () => {
      // The basic group grants can_play: the admin holds it, and so may grant it.
      const player = {
        ...tenantAdmin,
        permissions: [...tenantAdmin.permissions, "can_play"],
      };
      const res = await single(() =>
        handleSetEntitlementGroupActive(
          { group_id: cat.groups.basic, is_active: true },
          player
        )
      );
      expect(res.success).toBe(true);
      expect(await isActive(cat.groups.basic)).toBe(true);
      // Not past the page's rules: a group granting a permission the admin lacks is refused.
      const refused = await single(() =>
        handleSetEntitlementGroupActive(
          { group_id: cat.groups.mighty, is_active: true },
          {
            ...player,
            permissions: player.permissions.filter((p) => p !== "admin_manage_roles"),
          }
        )
      );
      expect(refused).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
      expect(await isActive(cat.groups.mighty)).toBe(false);
      // And only by those who may change the catalog.
      expect(
        await shared(() =>
          handleSetEntitlementGroupActive(
            { group_id: cat.groups.basic, is_active: false },
            player
          )
        )
      ).toMatchObject({ success: false, code: "admin.operator_only" });
    });
  });
});
