/**
 * @jest-environment node
 */
/**
 * Admin routes and command-bar handlers over a tenant's own data, on Postgres (ADR-053 D5)
 *
 * Users, their roles, feature restrictions, the audit log, GDPR purges, the password policy and
 * appeals are the current tenant's only: a tenant's administrator never sees or changes another
 * tenant's. Each route runs for real against the database in a test tenant; only token
 * verification, the permission lookup and the standing lookup are test callers
 * (helpers/db-admin.ts). The role rules (TASK-145), audit-first (audit X-8), bound search
 * (audit B-16/E-15) and self-targeting refusals are asserted as before.
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
jest.mock("@/platform/gdpr", () => ({ createPlatformPurgePipeline: jest.fn() }));
jest.mock("@/platform/ai", () => ({ getOrchestrator: jest.fn() }));
jest.mock("@/prompts", () => ({
  getPromptConfig: jest.fn(() => ({ tier: "standard", maxTokens: 1000, name: "admin" })),
  buildAdminSystemPrompt: jest.fn(() => "sys"),
}));
jest.mock("@/platform/moderation/store", () => ({ getModerationStore: jest.fn() }));
/** Whether this suite's direct-change cases have the action off the dual-control list. */
const mockDualControl = { off: false };
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
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import { createPlatformPurgePipeline } from "@/platform/gdpr";
import { getOrchestrator } from "@/platform/ai";
import { buildAdminSystemPrompt } from "@/prompts";
import { getModerationStore } from "@/platform/moderation/store";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { handleChangeUserRole } from "@/app/api/admin/ai/handlers/roles";
import {
  handleBlockUserFeature,
  handleUnblockUserFeature,
} from "@/app/api/admin/ai/handlers/restrictions";
import { handleSearch } from "@/app/api/admin/ai/handlers/search";
import { GET as usersGET, PATCH as usersPATCH } from "@/app/api/admin/users/route";
import { GET as auditGET } from "@/app/api/admin/audit/route";
import { GET as perAccountGET } from "@/app/api/admin/per-account/route";
import { POST as gdprPOST } from "@/app/api/admin/gdpr/route";
import { GET as pwGET, PUT as pwPUT } from "@/app/api/admin/password-policy/route";
import { POST as planPOST } from "@/app/api/admin/ai/route";
import { POST as appealPOST } from "@/app/api/moderation/appeals/route";
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
let a: TestTenant;
let b: TestTenant;
let cat: TestCatalog;
let superRole: string;
let freeRole: string;
let moderatorRole: string;

// Callers (real role permissions) and their user rows in tenant A.
let admin: TestIdentity;
let superAdmin: TestIdentity;

// Users of A and B.
let alice: string; // A, role ops
let bob: string; // A, role ops
let carol: string; // A
let gone: string; // A, deleted
let peerSuper: string; // A, super_admin
let outsider: string; // B, role ops

/** A command-bar admin holding the role and user permissions and the test codes x, y. */
let barAdmin: VerifiedAdmin;

const email = (label: string) => `${label}-${RUN}@x.test`;

async function q<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<R[]> {
  return (await withOwnerTx("operator", (tx) => tx.query<R>(text, values))).rows;
}
const roleOf = async (id: string) =>
  (await q<{ role_id: string }>("select role_id from users where id = $1::uuid", [id]))[0]
    ?.role_id;
const auditOf = (t: TestTenant) =>
  q<{
    action: string;
    actor_id: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
  }>(
    "select action, actor_id, target_id, details from audit_log where tenant_id = $1::uuid order by created_at, id",
    [t.id]
  );
const restrictionsOf = (t: TestTenant) =>
  q<{ user_id: string; feature: string; reason: string | null; created_by: string }>(
    "select user_id, feature, reason, created_by from user_feature_restrictions where tenant_id = $1::uuid order by feature",
    [t.id]
  );

function req(
  path: string,
  caller: Parameters<typeof asCallerIn>[0],
  options: { method?: string; body?: unknown; raw?: string; tenant?: TestTenant } = {}
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...asCallerIn(caller, options.tenant ?? a),
    },
    body:
      options.raw ??
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

const SUITE = "a tenant's own data, through the admin routes (ADR-053 D5)";

// Once per file, as before; nothing connects when the database is absent.
if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    cat = await createCatalog(RUN, {
      permissions: ["x", "y", "secret"],
      roles: { ops: ["x"], power: ["secret"], staff: [] },
    });
    superRole = await seededRoleId("super_admin");
    freeRole = await seededRoleId("free");
    moderatorRole = await seededRoleId("moderator");

    admin = suiteCaller("admin", RUN);
    superAdmin = suiteCaller("super_admin", RUN);
    await insertUser(a, { id: admin.userId, roleId: freeRole, email: email("admin") });
    await insertUser(a, { id: superAdmin.userId, roleId: superRole });

    alice = await insertUser(a, {
      roleId: cat.roles.ops,
      email: email("alice"),
      displayName: "Alice",
      createdAt: "2026-01-02T00:00:00Z",
    });
    bob = await insertUser(a, {
      roleId: cat.roles.ops,
      email: email("bob"),
      displayName: "Ali Bob",
      createdAt: "2026-01-01T00:00:00Z",
    });
    carol = await insertUser(a, {
      roleId: freeRole,
      email: email("carol"),
      displayName: "Carol",
      createdAt: "2026-01-03T00:00:00Z",
    });
    gone = await insertUser(a, {
      roleId: cat.roles.ops,
      email: email("gone"),
      deletedAt: "2026-01-04T00:00:00Z",
      createdAt: "2026-01-04T00:00:00Z",
    });
    peerSuper = await insertUser(a, { roleId: superRole, email: email("peer") });
    outsider = await insertUser(b, {
      roleId: cat.roles.ops,
      email: email("outsider"),
      displayName: "Alice Elsewhere",
    });

    barAdmin = {
      userId: admin.userId,
      sub: admin.sub,
      roleName: "admin",
      permissions: [
        "admin_manage_users",
        "admin_view_audit",
        "admin_manage_roles",
        cat.codes.x,
        cat.codes.y,
      ],
    };
  });
  afterAll(async () => {
    await dropTestTenants();
    await dropCatalog();
    await disconnectTestDatabase();
  });
}

dbDescribe(`${SUITE} handleChangeUserRole (command bar)`, () => {
  afterEach(async () => {
    await q("update users set role_id = $2::uuid where id = any($1::uuid[])", [
      [alice, bob, outsider],
      cat.roles.ops,
    ]);
  });

  it("records, then assigns a user found by email to a role", async () => {
    (invalidatePermissions as jest.Mock).mockClear();
    const before = (await auditOf(a)).length;
    const res = await a.run(() =>
      handleChangeUserRole(
        { user_identifier: email("alice"), new_role: cat.roleNames.staff },
        barAdmin
      )
    );
    expect(res.success).toBe(true);
    expect(await roleOf(alice)).toBe(cat.roles.staff);
    expect(invalidatePermissions).toHaveBeenCalledWith(`sub-${alice}`);
    expect((await auditOf(a)).slice(before)[0]).toMatchObject({
      action: "role_changed",
      actor_id: admin.userId,
      target_id: alice,
      details: expect.objectContaining({
        oldRole: cat.roleNames.ops,
        newRole: cat.roleNames.staff,
        outcome: "attempted",
      }),
    });
  });

  it("finds a user by exact id", async () => {
    const res = await a.run(() =>
      handleChangeUserRole(
        { user_identifier: bob, new_role: cat.roleNames.staff },
        barAdmin
      )
    );
    expect(res.success).toBe(true);
    expect(await roleOf(bob)).toBe(cat.roles.staff);
  });

  it("refuses when the target role is missing", async () => {
    const res = await a.run(() =>
      handleChangeUserRole({ user_identifier: alice, new_role: `ghost-${RUN}` }, barAdmin)
    );
    expect(res.success).toBe(false);
    expect(await roleOf(alice)).toBe(cat.roles.ops);
  });

  it("refuses a deleted user", async () => {
    const res = await a.run(() =>
      handleChangeUserRole(
        { user_identifier: email("gone"), new_role: cat.roleNames.staff },
        barAdmin
      )
    );
    expect(res.error).toMatch(/not found/);
    expect(await roleOf(gone)).toBe(cat.roles.ops);
  });

  it("refuses to change the admin's own role", async () => {
    const res = await a.run(() =>
      handleChangeUserRole(
        { user_identifier: email("admin"), new_role: cat.roleNames.ops },
        barAdmin
      )
    );
    expect(res).toMatchObject({ success: false, code: "auth.role_self_change" });
    expect(await roleOf(admin.userId)).toBe(freeRole);
  });

  it("refuses to assign super_admin, or to change a super_admin", async () => {
    const assign = await a.run(() =>
      handleChangeUserRole({ user_identifier: alice, new_role: "super_admin" }, barAdmin)
    );
    expect(assign).toMatchObject({ success: false, code: "auth.role_database_only" });
    const demote = await a.run(() =>
      handleChangeUserRole(
        { user_identifier: peerSuper, new_role: cat.roleNames.staff },
        barAdmin
      )
    );
    expect(demote).toMatchObject({ success: false, code: "auth.role_database_only" });
    expect(await roleOf(peerSuper)).toBe(superRole);
  });

  it("refuses to grant a role carrying a permission the admin lacks", async () => {
    const res = await a.run(() =>
      handleChangeUserRole(
        { user_identifier: alice, new_role: cat.roleNames.power },
        barAdmin
      )
    );
    expect(res).toMatchObject({ success: false, code: "auth.grant_exceeds_own" });
    expect(await roleOf(alice)).toBe(cat.roles.ops);
  });

  it.each(["by id", "by email"])(
    "never finds another tenant's user (%s)",
    async (how) => {
      const res = await a.run(() =>
        handleChangeUserRole(
          {
            user_identifier: how === "by id" ? outsider : email("outsider"),
            new_role: cat.roleNames.staff,
          },
          barAdmin
        )
      );
      expect(res.error).toMatch(/not found/);
      expect(await roleOf(outsider)).toBe(cat.roles.ops);
    }
  );

  it.each([
    `${"alice"}-x,role_id.neq.null`,
    "*",
    "%",
    "id.neq.00000000-0000-0000-0000-000000000000",
    "",
    "' or 1=1 --",
  ])(
    "treats a crafted identifier %p as a literal and changes no one",
    async (identifier) => {
      const before = await q<{ role_id: string }>(
        "select role_id from users where tenant_id = $1::uuid order by id",
        [a.id]
      );
      const res = await a.run(() =>
        handleChangeUserRole(
          { user_identifier: identifier, new_role: cat.roleNames.staff },
          barAdmin
        )
      );
      expect(res.success).toBe(false);
      expect(
        await q("select role_id from users where tenant_id = $1::uuid order by id", [
          a.id,
        ])
      ).toEqual(before);
    }
  );

  it("changes nothing when the audit log is unavailable", async () => {
    const res = await a.run(() =>
      handleChangeUserRole(
        { user_identifier: alice, new_role: cat.roleNames.staff },
        { ...barAdmin, userId: `not-a-user-${RUN}` }
      )
    );
    expect(res).toMatchObject({ success: false, code: "service.unavailable" });
    expect(await roleOf(alice)).toBe(cat.roles.ops);
  });
});

dbDescribe(`${SUITE} GET /api/admin/users`, () => {
  const ids = async (path: string, caller: TestIdentity = superAdmin) => {
    const res = await usersGET(req(path, caller));
    expect(res.status).toBe(200);
    return (await res.json()).users.map((u: { id: string }) => u.id);
  };

  it("lists this tenant's users only, newest first, with role names", async () => {
    const res = await usersGET(req("/api/admin/users?limit=100", admin));
    const body = await res.json();
    const listed = body.users.map((u: { id: string }) => u.id);
    expect(listed).toEqual(expect.arrayContaining([alice, bob, carol, gone, peerSuper]));
    expect(listed).not.toContain(outsider);
    const a1 = body.users.find((u: { id: string }) => u.id === alice);
    expect(a1).toMatchObject({
      email: email("alice"),
      displayName: "Alice",
      roleName: cat.roleNames.ops,
      createdAt: "2026-01-02T00:00:00.000Z",
      isDeleted: false,
    });
    expect(body.users.find((u: { id: string }) => u.id === gone).isDeleted).toBe(true);
    expect(body.roles.some((r: { name: string }) => r.name === cat.roleNames.ops)).toBe(
      true
    );
  });

  it("matches email or name, newest first, each user once — never another tenant's", async () => {
    expect(await ids("/api/admin/users?q=ali")).toEqual([alice, bob]);
  });

  it.each(["x,id.neq.0", "%", "_", "*", "a)(b", "\\", "' or ''='"])(
    "treats %p as text, never as filter syntax or a wildcard",
    async (term) => {
      const listed = await ids(`/api/admin/users?q=${encodeURIComponent(term)}`);
      const all = await ids("/api/admin/users?limit=100");
      // Nothing contains these characters: no match, or (a term of only wildcards) no search.
      expect(listed.length === 0 || listed.length === all.length).toBe(true);
      expect(listed).not.toContain(outsider);
    }
  );

  it("pages the search exactly", async () => {
    // alice (01-02), then bob (01-01).
    expect(await ids("/api/admin/users?q=ali&limit=1&offset=1")).toEqual([bob]);
  });

  it.each([
    ["x", "y"],
    ["-1", "-5"],
    ["1e9", "1e9"],
    ["NaN", "Infinity"],
    ["2.5", "0x10"],
  ])("bounds limit=%p offset=%p", async (limit, offset) => {
    for (const route of [usersGET, auditGET]) {
      const res = await route(
        req(
          `/api/admin/x?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
          superAdmin
        )
      );
      expect(res.status).toBe(200);
    }
  });

  it("refuses a moderator", async () => {
    expect(
      (await usersGET(req("/api/admin/users", suiteCaller("moderator", RUN)))).status
    ).toBe(403);
  });
});

dbDescribe(`${SUITE} PATCH /api/admin/users under dual control (audit X-10)`, () => {
  it("holds a role change for a second admin by default, and changes nothing", async () => {
    const before = (await auditOf(a)).length;
    const res = await usersPATCH(
      req("/api/admin/users", admin, {
        method: "PATCH",
        body: { userId: carol, roleId: moderatorRole },
      })
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ held: true, proposalId: expect.any(String) });
    expect(await roleOf(carol)).toBe(freeRole);
    expect(
      (await auditOf(a)).slice(before).filter((r) => r.action === "role_changed")
    ).toEqual([]);
  });
});

dbDescribe(`${SUITE} PATCH /api/admin/users`, () => {
  const patch = (body: unknown, caller: Parameters<typeof asCallerIn>[0] = admin) =>
    usersPATCH(req("/api/admin/users", caller, { method: "PATCH", body }));

  // These cases are the direct change: the role-change action taken off the dual-control list
  // (an operator's governed choice) — for this suite only, through the route's reading of the
  // list. The shared configuration row is never changed: suites run in parallel against one
  // database, and another suite's holds must not depend on this one's timing.
  beforeAll(() => {
    mockDualControl.off = true;
  });
  afterAll(() => {
    mockDualControl.off = false;
  });

  afterEach(async () => {
    await q("update users set role_id = $2::uuid where id = $1::uuid", [carol, freeRole]);
    await q("update users set role_id = $2::uuid where id = $1::uuid", [
      outsider,
      cat.roles.ops,
    ]);
  });

  it("changes the role and records who did it", async () => {
    const before = (await auditOf(a)).length;
    const res = await patch({ userId: carol, roleId: moderatorRole });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(await roleOf(carol)).toBe(moderatorRole);
    expect((await auditOf(a)).slice(before)[0]).toMatchObject({
      action: "role_changed",
      actor_id: admin.userId,
      target_id: carol,
      details: expect.objectContaining({ newRole: "moderator", oldRole: "free" }),
    });
  });

  it.each([
    ["an unknown user", () => ({ userId: randomUUID(), roleId: moderatorRole }), 404],
    ["an unknown role", () => ({ userId: carol, roleId: randomUUID() }), 404],
    ["a role id that is not an id", () => ({ userId: carol, roleId: "r-ghost" }), 404],
    ["super_admin", () => ({ userId: carol, roleId: superRole }), 403],
    [
      "a role with a permission the admin lacks",
      () => ({ userId: carol, roleId: cat.roles.power }),
      403,
    ],
    ["another tenant's user", () => ({ userId: outsider, roleId: moderatorRole }), 404],
  ])("refuses %s and changes nothing", async (_label, body, status) => {
    const res = await patch(body());
    expect(res.status).toBe(status);
    expect(await roleOf(carol)).toBe(freeRole);
    expect(await roleOf(outsider)).toBe(cat.roles.ops);
  });

  it("refuses to demote a super_admin", async () => {
    const res = await patch({ userId: peerSuper, roleId: freeRole });
    expect(res.status).toBe(403);
    expect(await roleOf(peerSuper)).toBe(superRole);
  });

  it("refuses an admin changing their own role", async () => {
    const res = await patch({ userId: admin.userId, roleId: moderatorRole });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.role_self_change");
  });

  it.each([[{ roleId: "r" }], [{ userId: 1, roleId: "r" }]])(
    "400s on %p",
    async (body) => {
      expect((await patch(body)).status).toBe(400);
    }
  );

  it("400s on a malformed body", async () => {
    const res = await usersPATCH(
      req("/api/admin/users", admin, { method: "PATCH", raw: "{nope" })
    );
    expect(res.status).toBe(400);
  });

  it.each(["anonymous", "free", "moderator", "safety_approver"] as const)(
    "refuses %s",
    async (role) => {
      const res = await patch(
        { userId: carol, roleId: moderatorRole },
        role === "anonymous" ? role : suiteCaller(role, RUN)
      );
      expect([401, 403]).toContain(res.status);
      expect(await roleOf(carol)).toBe(freeRole);
    }
  );

  it("does not change the role when the audit log is unavailable", async () => {
    const res = await patch(
      { userId: carol, roleId: moderatorRole },
      callerWithUnrecordableId("admin", RUN)
    );
    expect(res.status).toBe(503);
    expect(await roleOf(carol)).toBe(freeRole);
  });
});

dbDescribe(`${SUITE} GET /api/admin/audit`, () => {
  let t: TestTenant;
  let actor: string;
  let target: string;
  let ids: Record<string, string>;
  const entries = async (path: string, tenant = t) => {
    const res = await auditGET(req(path, superAdmin, { tenant }));
    expect(res.status).toBe(200);
    return (await res.json()).entries;
  };

  beforeAll(async () => {
    // A tenant of its own, so the log holds exactly these records.
    t = await createTestTenant();
    actor = randomUUID();
    target = randomUUID();
    ids = {};
    await withOwnerTx("operator", async (tx) => {
      const add = async (
        label: string,
        tenant: TestTenant,
        action: string,
        actorId: string,
        targetId: string,
        at: string
      ) => {
        const { rows } = await tx.query<{ id: string }>(
          `insert into audit_log (action, actor_id, target_id, details, created_at, tenant_id)
             values ($1::audit_action, $2::uuid, $3::uuid, '{"n":1}', $4::timestamptz, $5::uuid)
             returning id`,
          [action, actorId, targetId, at, tenant.id]
        );
        ids[label] = rows[0].id;
      };
      await add("e1", t, "role_changed", actor, target, "2026-01-01T00:00:00Z");
      await add("e2", t, "consent_granted", target, target, "2026-01-02T00:00:00Z");
      await add("e3", t, "role_changed", target, actor, "2026-01-03T00:00:00Z");
      await add("other", b, "role_changed", actor, target, "2026-01-04T00:00:00Z");
    });
  });

  it("lists this tenant's records only, newest first, mapped", async () => {
    const all = await entries("/api/admin/audit");
    expect(all.map((e: { id: string }) => e.id)).toEqual([ids.e3, ids.e2, ids.e1]);
    expect(all[2]).toEqual({
      id: ids.e1,
      action: "role_changed",
      actorId: actor,
      targetId: target,
      details: '{"n":1}',
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("finds a user's records as actor or target by id — in this tenant", async () => {
    expect(
      (await entries(`/api/admin/audit?q=${actor}`)).map((e: { id: string }) => e.id)
    ).toEqual([ids.e3, ids.e1]);
  });

  it("finds records by action name", async () => {
    expect(
      (await entries("/api/admin/audit?q=consent")).map((e: { id: string }) => e.id)
    ).toEqual([ids.e2]);
  });

  it("pages", async () => {
    const page = await auditGET(
      req("/api/admin/audit?limit=1&offset=1", superAdmin, { tenant: t })
    );
    const body = await page.json();
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual([ids.e2]);
    expect(body.hasMore).toBe(true);
  });

  it.each(["x,actor_id.neq.0", "nothing-like-an-action", "%", "' or 1=1 --"])(
    "returns nothing for %p, without an error",
    async (term) => {
      expect(await entries(`/api/admin/audit?q=${encodeURIComponent(term)}`)).toEqual([]);
    }
  );

  it("refuses a caller without admin_view_audit", async () => {
    const res = await auditGET(
      req("/api/admin/audit", suiteCaller("moderator", RUN), { tenant: t })
    );
    expect(res.status).toBe(403);
  });
});

dbDescribe(`${SUITE} feature restrictions`, () => {
  const ACTOR = () => admin.userId;

  afterEach(async () => {
    await q("delete from user_feature_restrictions where tenant_id = any($1::uuid[])", [
      [a.id, b.id],
    ]);
  });

  it("records, then blocks the feature", async () => {
    const before = (await auditOf(a)).length;
    const r = await a.run(() =>
      handleBlockUserFeature(
        { user_id: alice, feature: "agent_delegate", reason: "abuse" },
        ACTOR()
      )
    );
    expect(r.success).toBe(true);
    expect(await restrictionsOf(a)).toEqual([
      {
        user_id: alice,
        feature: "agent_delegate",
        reason: "abuse",
        created_by: ACTOR(),
      },
    ]);
    expect((await auditOf(a)).slice(before)[0]).toMatchObject({
      actor_id: ACTOR(),
      target_id: alice,
      details: expect.objectContaining({
        type: "block_user_feature",
        outcome: "attempted",
      }),
    });
  });

  it("is idempotent: blocking twice leaves one block, with the latest reason", async () => {
    await a.run(() => handleBlockUserFeature({ user_id: alice, feature: "x" }, ACTOR()));
    await a.run(() =>
      handleBlockUserFeature({ user_id: alice, feature: "x", reason: "again" }, ACTOR())
    );
    expect(await restrictionsOf(a)).toEqual([
      expect.objectContaining({ feature: "x", reason: "again" }),
    ]);
  });

  it("cannot block another tenant's user: the block fails, and is recorded as failed", async () => {
    const before = (await auditOf(a)).length;
    const r = await a.run(() =>
      handleBlockUserFeature({ user_id: outsider, feature: "x" }, ACTOR())
    );
    expect(r.success).toBe(false);
    expect(await restrictionsOf(b)).toEqual([]);
    expect((await auditOf(a)).slice(before).map((row) => row.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
  });

  it("requires user_id and feature, and refuses a malformed id", async () => {
    for (const input of [
      { feature: "x" },
      { user_id: alice },
      { user_id: "u1", feature: "x" },
      { user_id: "x,feature.neq.null", feature: "x" },
      { user_id: 7, feature: "x" },
      { user_id: alice, feature: 7 },
    ]) {
      expect((await a.run(() => handleBlockUserFeature(input, ACTOR()))).success).toBe(
        false
      );
    }
    expect(await restrictionsOf(a)).toEqual([]);
  });

  it.each([
    ["block", handleBlockUserFeature],
    ["unblock", handleUnblockUserFeature],
  ])("an administrator does not %s their own account", async (_l, handler) => {
    const r = await a.run(() => handler({ user_id: ACTOR(), feature: "x" }, ACTOR()));
    expect(r).toMatchObject({ success: false, code: "admin.self_target" });
  });

  it("does not block when the audit log is unavailable", async () => {
    const r = await a.run(() =>
      handleBlockUserFeature({ user_id: alice, feature: "x" }, `not-a-user-${RUN}`)
    );
    expect(r).toMatchObject({ success: false, code: "service.unavailable" });
    expect(await restrictionsOf(a)).toEqual([]);
  });

  describe("unblock", () => {
    beforeEach(async () => {
      await a.run(() =>
        handleBlockUserFeature({ user_id: alice, feature: "agent_delegate" }, ACTOR())
      );
      await a.run(() =>
        handleBlockUserFeature({ user_id: alice, feature: "translate" }, ACTOR())
      );
      await b.run(() =>
        handleBlockUserFeature({ user_id: outsider, feature: "agent_delegate" }, ACTOR())
      );
    });

    it("removes only that block, in this tenant only", async () => {
      const r = await a.run(() =>
        handleUnblockUserFeature({ user_id: alice, feature: "agent_delegate" }, ACTOR())
      );
      expect(r.success).toBe(true);
      expect((await restrictionsOf(a)).map((x) => x.feature)).toEqual(["translate"]);
      // Tenant A's admin naming B's user removes nothing of B's.
      await a.run(() =>
        handleUnblockUserFeature(
          { user_id: outsider, feature: "agent_delegate" },
          ACTOR()
        )
      );
      expect(await restrictionsOf(b)).toHaveLength(1);
    });

    it("requires both fields", async () => {
      expect(
        (await a.run(() => handleUnblockUserFeature({ user_id: alice }, ACTOR()))).success
      ).toBe(false);
    });

    it("does not unblock when the audit log is unavailable", async () => {
      const r = await a.run(() =>
        handleUnblockUserFeature(
          { user_id: alice, feature: "agent_delegate" },
          `not-a-user-${RUN}`
        )
      );
      expect(r.success).toBe(false);
      expect(await restrictionsOf(a)).toHaveLength(2);
    });

    it("GET /api/admin/per-account lists this tenant's blocks only", async () => {
      const res = await perAccountGET(req("/api/admin/per-account", superAdmin));
      expect(res.status).toBe(200);
      const { restrictions } = await res.json();
      expect(restrictions.map((r: { feature: string }) => r.feature).sort()).toEqual([
        "agent_delegate",
        "translate",
      ]);
      expect(restrictions.every((r: { user_id: string }) => r.user_id === alice)).toBe(
        true
      );
      expect(typeof restrictions[0].created_at).toBe("string");
    });

    it("GET /api/admin/per-account refuses a moderator", async () => {
      expect(
        (
          await perAccountGET(
            req("/api/admin/per-account", suiteCaller("moderator", RUN))
          )
        ).status
      ).toBe(403);
    });
  });
});

dbDescribe(`${SUITE} handleSearch (command bar)`, () => {
  it("reads users — this tenant's only", async () => {
    const res = await a.run(() => handleSearch({ table: "users" }, barAdmin));
    expect(res.success).toBe(true);
    const rows = JSON.parse(res.result!);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { tenant_id: string }) => r.tenant_id === a.id)).toBe(true);
  });

  it("reads the shared catalog", async () => {
    const res = await a.run(() => handleSearch({ table: "roles" }, barAdmin));
    expect(res.success).toBe(true);
    expect(JSON.parse(res.result!).length).toBeGreaterThan(0);
  });

  it("refuses a table outside the allowlist", async () => {
    const res = await a.run(() =>
      handleSearch({ table: "user_feature_restrictions" }, barAdmin)
    );
    expect(res).toMatchObject({ success: false, code: "request.invalid_value" });
  });

  it("refuses an allowlisted table whose permission the admin lacks", async () => {
    const res = await a.run(() => handleSearch({ table: "platform_config" }, barAdmin));
    expect(res).toMatchObject({
      success: false,
      code: "auth.permission_denied",
      params: { permission: "config_view" },
    });
  });

  it.each(["__proto__", "constructor", "toString", "users; drop table users"])(
    "refuses the crafted table name %p",
    async (table) => {
      expect((await a.run(() => handleSearch({ table }, barAdmin))).success).toBe(false);
    }
  );
});

dbDescribe(`${SUITE} POST /api/admin/gdpr`, () => {
  const execute = jest.fn();
  const purge = (
    caller: Parameters<typeof asCallerIn>[0] = superAdmin,
    body: unknown = { userId: carol, reason: "admin-action" },
    raw?: string
  ) => gdprPOST(req("/api/admin/gdpr", caller, { method: "POST", body, raw }));

  beforeEach(() => {
    (createPlatformPurgePipeline as unknown as jest.Mock).mockClear();
    execute.mockReset().mockResolvedValue({
      purgeId: "pg1",
      status: "completed",
      totalDeleted: 3,
      steps: [{ handler: "db", success: true, deletedCount: 3 }],
    });
    (createPlatformPurgePipeline as unknown as jest.Mock).mockImplementation(() => ({
      execute,
    }));
  });

  it("purges for a super_admin, recording them as the requester", async () => {
    const before = (await auditOf(a)).length;
    const res = await purge();
    expect(res.status).toBe(200);
    expect((await res.json()).purgeId).toBe("pg1");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: superAdmin.userId, userId: carol })
    );
    // The platform's own pipeline, for this requester (audit X-15: it had no handler).
    expect(createPlatformPurgePipeline).toHaveBeenCalledWith(superAdmin.userId);
    expect((await auditOf(a)).slice(before)[0]).toMatchObject({
      action: "gdpr_purge_executed",
      actor_id: superAdmin.userId,
      target_id: carol,
    });
  });

  it.each(["anonymous", "free", "moderator", "safety_approver", "admin"] as const)(
    "refuses %s (audit X-15)",
    async (role) => {
      const res = await purge(role === "anonymous" ? role : suiteCaller(role, RUN));
      expect([401, 403]).toContain(res.status);
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("refuses a user of another tenant: 404, nothing purged or recorded anywhere", async () => {
    const auditA = (await auditOf(a)).length;
    const auditB = (await auditOf(b)).length;
    const res = await purge(superAdmin, { userId: outsider, reason: "admin-action" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: "admin.target_not_found",
      params: { target: "user" },
    });
    expect(createPlatformPurgePipeline).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect((await auditOf(a)).length).toBe(auditA);
    expect((await auditOf(b)).length).toBe(auditB);
    expect(
      await q("select 1 as one from users where id = $1::uuid and tenant_id = $2::uuid", [
        outsider,
        b.id,
      ])
    ).toEqual([{ one: 1 }]);
    // A dry run is refused the same way.
    const dry = await purge(superAdmin, {
      userId: outsider,
      reason: "admin-action",
      dryRun: true,
    });
    expect(dry.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an id that is no user at all: 404", async () => {
    const res = await purge(superAdmin, { userId: randomUUID(), reason: "admin-action" });
    expect(res.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("purges a soft-deleted user of this tenant (erasing a deleted account)", async () => {
    const res = await purge(superAdmin, { userId: gone, reason: "account-deletion" });
    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ userId: gone }));
  });

  it("refuses a super_admin purging their own account", async () => {
    const res = await purge(superAdmin, {
      userId: superAdmin.userId,
      reason: "admin-action",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("admin.self_target");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to purge another super_admin", async () => {
    const res = await purge(superAdmin, { userId: peerSuper, reason: "admin-action" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.role_protected");
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers 503, not success, when no purge handler ran", async () => {
    execute.mockResolvedValue({
      purgeId: "p",
      status: "failed",
      totalDeleted: 0,
      steps: [],
    });
    expect((await purge()).status).toBe(503);
  });

  it.each([
    ["invalid JSON", undefined, "{not json"],
    ["a missing userId", { reason: "admin-action" }, undefined],
    ["a user id that is not one", { userId: "u1", reason: "admin-action" }, undefined],
    ["an invalid reason", { userId: randomUUID(), reason: "nope" }, undefined],
  ])("400s on %s", async (_label, body, raw) => {
    expect((await purge(superAdmin, body, raw)).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("500s when the pipeline throws", async () => {
    execute.mockRejectedValue(new Error("pipeline down"));
    expect((await purge()).status).toBe(500);
  });

  it("does not run a purge when the audit log is unavailable", async () => {
    const res = await purge(callerWithUnrecordableId("super_admin", RUN));
    expect(res.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();
  });
});

dbDescribe(`${SUITE} /api/admin/password-policy`, () => {
  let t: TestTenant;
  const policyRows = () =>
    q<{ min_length: number; rotation_days: number }>(
      "select min_length, rotation_days from password_policy where tenant_id = $1::uuid and role_id is null and user_id is null",
      [t.id]
    );

  beforeAll(async () => {
    t = await createTestTenant();
  });

  it("GET returns the defaults when no policy is stored, then the stored one", async () => {
    const first = await (
      await pwGET(req("/api/admin/password-policy", superAdmin, { tenant: t }))
    ).json();
    expect(first.policy.minLength).toBe(12);
    const put = await pwPUT(
      req("/api/admin/password-policy", superAdmin, {
        method: "PUT",
        body: { minLength: 14 },
        tenant: t,
      })
    );
    expect(put.status).toBe(200);
    expect(await policyRows()).toEqual([{ min_length: 14, rotation_days: 90 }]);
    const second = await (
      await pwGET(req("/api/admin/password-policy", superAdmin, { tenant: t }))
    ).json();
    expect(second.policy).toMatchObject({ minLength: 14, rotationDays: 90 });
    expect((await auditOf(t)).at(-1)).toMatchObject({ actor_id: superAdmin.userId });
    // Another tenant's policy is its own.
    const other = await (
      await pwGET(req("/api/admin/password-policy", superAdmin, { tenant: b }))
    ).json();
    expect(other.policy.minLength).toBe(12);
  });

  it.each([
    [{ minLength: 3 }],
    [{ minLength: "16" }],
    [{ rotationDays: -5 }],
    [{ unknownField: 1 }],
  ])("PUT refuses %p and writes nothing", async (body) => {
    const before = await policyRows();
    const res = await pwPUT(
      req("/api/admin/password-policy", superAdmin, { method: "PUT", body, tenant: t })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("request.invalid_value");
    expect(await policyRows()).toEqual(before);
  });

  it.each(["anonymous", "free", "moderator", "safety_approver", "admin"] as const)(
    "PUT refuses %s",
    async (role) => {
      const before = await policyRows();
      const res = await pwPUT(
        req(
          "/api/admin/password-policy",
          role === "anonymous" ? role : suiteCaller(role, RUN),
          {
            method: "PUT",
            body: { minLength: 20 },
            tenant: t,
          }
        )
      );
      expect([401, 403]).toContain(res.status);
      expect(await policyRows()).toEqual(before);
    }
  );

  it("PUT does not change the policy when the audit log is unavailable", async () => {
    const before = await policyRows();
    const res = await pwPUT(
      req("/api/admin/password-policy", callerWithUnrecordableId("super_admin", RUN), {
        method: "PUT",
        body: { minLength: 30 },
        tenant: t,
      })
    );
    expect(res.status).toBe(503);
    expect(await policyRows()).toEqual(before);
  });
});

dbDescribe(`${SUITE} POST /api/admin/ai — panel context`, () => {
  beforeEach(() => {
    (getOrchestrator as jest.Mock).mockReturnValue({
      complete: jest.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    });
    (buildAdminSystemPrompt as jest.Mock).mockClear();
  });
  const plan = (panel: string, tenant: TestTenant) =>
    planPOST(
      req("/api/admin/ai", superAdmin, {
        method: "POST",
        body: { prompt: "x", panel },
        tenant,
      })
    );

  it("counts this tenant's active users only", async () => {
    const t = await createTestTenant();
    await insertUser(t, { roleId: freeRole });
    await insertUser(t, { roleId: freeRole });
    await insertUser(t, { roleId: freeRole, deletedAt: "2026-01-01T00:00:00Z" });
    expect((await plan("users", t)).status).toBe(200);
    expect((buildAdminSystemPrompt as jest.Mock).mock.calls[0][1]).toMatch(
      /^Total active users: 2\nRoles: \[/
    );
  });

  it.each(["roles", "entitlements"])(
    "reads the shared catalog for the %s panel",
    async (panel) => {
      expect((await plan(panel, a)).status).toBe(200);
      const context = (buildAdminSystemPrompt as jest.Mock).mock.calls[0][1] as string;
      expect(context).toMatch(/permissions: \[\{/);
      if (panel === "roles") expect(context).toContain(cat.roleNames.ops);
    }
  );
});

dbDescribe(
  `${SUITE} POST /api/moderation/appeals — the appellant is this tenant's user`,
  () => {
    const appellant = () => suiteCaller("free", RUN, { name: "appellant" });
    const appeal = (tenant: TestTenant) =>
      appealPOST(
        req("/api/moderation/appeals", appellant(), {
          method: "POST",
          body: { originalDecisionId: "d1", appealReason: "not me" },
          tenant,
        })
      );

    beforeAll(async () => {
      // The caller's account exists in B only.
      await insertUser(b, { roleId: freeRole, cognitoSub: appellant().sub });
      (getModerationStore as jest.Mock).mockReturnValue({
        queryAudits: jest.fn().mockResolvedValue([]),
      });
    });

    it("finds the appellant in their own tenant", async () => {
      const res = await appeal(b);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("moderation.decision_not_found");
    });

    it("does not find them in another tenant", async () => {
      const res = await appeal(a);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("account.not_found");
    });
  }
);

// ── TASK-185: the Users screen's list — status, sign-in, search, sort and paging bounds ─────────

dbDescribe(`${SUITE} GET /api/admin/users — the Users screen (TASK-185)`, () => {
  const list = async (path: string, caller: TestIdentity = superAdmin) => {
    const res = await usersGET(req(path, caller));
    return { status: res.status, body: await res.json() };
  };
  const userOf = (body: { users: { id: string }[] }, id: string) =>
    body.users.find((u) => u.id === id) as Record<string, unknown> | undefined;

  let dana: string; // A: no address, suspended until a past date, signed in long ago
  let erin: string; // A: banned, signed in recently, one entitlement
  let group: string;

  beforeAll(async () => {
    dana = await insertUser(a, {
      roleId: freeRole,
      email: null,
      createdAt: "2026-06-07T12:00:00Z",
    });
    erin = await insertUser(a, {
      roleId: freeRole,
      email: email("erin"),
      displayName: "Erin",
      createdAt: "2026-02-01T00:00:00Z",
      emailVerified: true,
    });
    await q(
      `update users set account_status = 'suspended', suspended_until = now() - interval '1 day',
              last_login_at = '2026-06-08T09:00:00Z' where id = $1::uuid`,
      [dana]
    );
    await q(
      `update users set account_status = 'banned', banned_at = now(),
              last_login_at = now() where id = $1::uuid`,
      [erin]
    );
    group = (
      await q<{ id: string }>(
        `insert into entitlement_groups (code, display_name) values ($1, $2) returning id`,
        [`beta-${RUN}`, "Beta access"]
      )
    )[0]!.id;
    await q(
      `insert into user_entitlements (user_id, entitlement_group_id, tenant_id)
       values ($1::uuid, $2::uuid, $3::uuid)`,
      [erin, group, a.id]
    );
    // A grant of an inactive group is not current either (platform/auth/entitlements.ts).
    const inactive = (
      await q<{ id: string }>(
        `insert into entitlement_groups (code, display_name, is_active) values ($1, $2, false)
         returning id`,
        [`off-${RUN}`, "Switched off"]
      )
    )[0]!.id;
    await q(
      `insert into user_entitlements (user_id, entitlement_group_id, tenant_id)
       values ($1::uuid, $2::uuid, $3::uuid)`,
      [erin, inactive, a.id]
    );
    // An expired and a revoked grant are not current: never listed.
    await q(
      `insert into user_entitlements (user_id, entitlement_group_id, tenant_id, expires_at)
       select $1::uuid, $2::uuid, $3::uuid, now() - interval '1 day'`,
      [dana, group, a.id]
    );
  });
  afterAll(async () => {
    const codes = [`beta-${RUN}`, `off-${RUN}`];
    await q(
      `delete from user_entitlements where entitlement_group_id in
         (select id from entitlement_groups where code = any($1::text[]))`,
      [codes]
    );
    await q("delete from entitlement_groups where code = any($1::text[])", [codes]);
  });

  it("each row carries its standing, verification, last sign-in and current entitlements", async () => {
    const { status, body } = await list("/api/admin/users?limit=100");
    expect(status).toBe(200);
    expect(userOf(body, dana)).toMatchObject({
      email: null,
      // An expired suspension is over, as the status guard reads it.
      status: "active",
      statusUntil: null,
      emailVerified: false,
      lastSignInAt: "2026-06-08T09:00:00.000Z",
      entitlements: [],
      roleName: "free",
    });
    expect(userOf(body, erin)).toMatchObject({
      status: "banned",
      emailVerified: true,
      entitlements: [{ code: `beta-${RUN}`, name: "Beta access", expiresAt: null }],
    });
    expect(userOf(body, gone)).toMatchObject({ status: "deleted", isDeleted: true });
    expect(userOf(body, alice)).toMatchObject({ lastSignInAt: null });
    expect(userOf(body, peerSuper)).toMatchObject({
      roleName: "super_admin",
      roleDisplayName: "Super Admin",
    });
    expect(body.page).toMatchObject({
      limit: 100,
      offset: 0,
      sort: "created",
      dir: "desc",
    });
  });

  it("sorts by last sign-in, never-signed-in last (desc) or first (asc)", async () => {
    const desc = (
      await list("/api/admin/users?limit=100&sort=last_sign_in")
    ).body.users.map((u: { id: string }) => u.id);
    expect(desc.indexOf(erin)).toBeLessThan(desc.indexOf(dana));
    expect(desc.indexOf(dana)).toBeLessThan(desc.indexOf(alice));
    const asc = (
      await list("/api/admin/users?limit=100&sort=last_sign_in&dir=asc")
    ).body.users.map((u: { id: string }) => u.id);
    expect(asc.indexOf(alice)).toBeLessThan(asc.indexOf(dana));
    expect(asc.indexOf(dana)).toBeLessThan(asc.indexOf(erin));
  });

  it("sorts by created, oldest first", async () => {
    const asc = (await list("/api/admin/users?limit=100&dir=asc")).body.users.map(
      (u: { id: string }) => u.id
    );
    expect(asc.indexOf(bob)).toBeLessThan(asc.indexOf(alice));
    expect(asc.indexOf(alice)).toBeLessThan(asc.indexOf(carol));
  });

  it("pages with one row of look-ahead: hasMore, then the next page", async () => {
    const first = (await list("/api/admin/users?q=ali&limit=1")).body;
    expect(first.users.map((u: { id: string }) => u.id)).toEqual([alice]);
    expect(first.page.hasMore).toBe(true);
    const second = (await list("/api/admin/users?q=ali&limit=1&offset=1")).body;
    expect(second.users.map((u: { id: string }) => u.id)).toEqual([bob]);
    expect(second.page.hasMore).toBe(false);
  });

  it.each([
    ["limit=1000", { limit: 100, offset: 0 }],
    ["limit=0", { limit: 50, offset: 0 }],
    ["offset=999999999", { limit: 50, offset: 10_000 }],
    ["q=ali&offset=5000", { limit: 50, offset: 900 }],
  ])("bounds %s → %p", async (qs, page) => {
    const { status, body } = await list(`/api/admin/users?${qs}`);
    expect(status).toBe(200);
    expect(body.page).toMatchObject(page);
    expect(body.users.length).toBeLessThanOrEqual(100);
  });

  it.each([
    ["sort", "created_at desc; drop table users --"],
    ["sort", "email"],
    ["sort", "CREATED"],
    ["dir", "desc nulls first"],
    ["dir", "up"],
  ])(
    "refuses %s=%p by name, never as SQL (request.invalid_value)",
    async (field, value) => {
      const { status, body } = await list(
        `/api/admin/users?${field}=${encodeURIComponent(value)}`
      );
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "request.invalid_value", params: { field } });
      // The table is still there, and still lists.
      expect((await list("/api/admin/users")).status).toBe(200);
    }
  );

  it("a hostile term is text: the payload first, then past the 100-character bound", async () => {
    // Spliced into SQL this would fail (500) or match every row (`or 1=1`); bound, it is text.
    const term = `%' or 1=1 -- ${"a".repeat(150)}`;
    const { status, body } = await list(`/api/admin/users?q=${encodeURIComponent(term)}`);
    expect(status).toBe(200);
    expect(body.users).toEqual([]);
  });

  it("_ and % match themselves (likeTerm escapes them): john_doe, not johnXdoe; 50% not 500", async () => {
    const underscore = await insertUser(a, {
      roleId: freeRole,
      displayName: `john_doe ${RUN}`,
    });
    const lookalike = await insertUser(a, {
      roleId: freeRole,
      displayName: `johnXdoe ${RUN}`,
    });
    const percent = await insertUser(a, { roleId: freeRole, displayName: `50% ${RUN}` });
    const fivehundred = await insertUser(a, {
      roleId: freeRole,
      displayName: `500 ${RUN}`,
    });
    const found = async (q: string) =>
      (
        await list(`/api/admin/users?limit=100&q=${encodeURIComponent(`${q} ${RUN}`)}`)
      ).body.users.map((u: { id: string }) => u.id);
    // Stripped (the old likeTerm), "john_doe" searched "johndoe": neither was found. As a
    // wildcard, `_` found both.
    expect(await found("john_doe")).toEqual([underscore]);
    expect(await found("john%doe")).toEqual([]);
    expect(await found("50%")).toEqual([percent]);
    expect(await found("5_0")).toEqual([]);
    // The look-alikes are there to be found: a plain search finds them, so their absence above
    // is the escaping, not an account missing.
    const all = (
      await list(`/api/admin/users?limit=100&q=${encodeURIComponent(RUN)}`)
    ).body.users.map((u: { id: string }) => u.id);
    expect(all).toEqual(
      expect.arrayContaining([underscore, lookalike, percent, fivehundred])
    );
  });

  it("an action the screen hides is refused by its route anyway (the same permission map)", async () => {
    const moderator = suiteCaller("moderator", RUN);
    expect(
      (
        await usersPATCH(
          req("/api/admin/users", moderator, {
            method: "PATCH",
            body: { userId: carol, roleId: moderatorRole },
          })
        )
      ).status
    ).toBe(403);
    // The admin role has no admin_purge_user_data: the screen offers no erase, the route refuses.
    expect(
      (
        await gdprPOST(
          req("/api/admin/gdpr", admin, {
            method: "POST",
            body: { userId: carol, reason: "admin-action" },
          })
        )
      ).status
    ).toBe(403);
    expect(createPlatformPurgePipeline).not.toHaveBeenCalledWith(admin.userId);
    expect(await roleOf(carol)).toBe(freeRole);
  });
});
