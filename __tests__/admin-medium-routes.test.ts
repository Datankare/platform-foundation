/**
 * __tests__/admin-medium-routes.test.ts — password-policy, entitlements and gdpr admin routes
 *
 * The admin guard is real (helpers/test-identities.ts): each route is called as the roles that
 * may use it and the roles that must be refused. Data lives in an in-memory database
 * (helpers/fake-database.ts), so each test asserts what was — or was not — written.
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
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/platform/gdpr", () => ({ PurgePipeline: jest.fn() }));

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { PurgePipeline } from "@/platform/gdpr";
import { FakeDatabase } from "./helpers/fake-database";

import { GET as pwGET, PUT as pwPUT } from "@/app/api/admin/password-policy/route";
import { GET as entGET, PATCH as entPATCH } from "@/app/api/admin/entitlements/route";
import { POST as gdprPOST } from "@/app/api/admin/gdpr/route";
import { PATCH as usersPATCH } from "@/app/api/admin/users/route";

const MockPurgePipeline = PurgePipeline as unknown as jest.Mock;
let db: FakeDatabase;

function req(
  method: string,
  body?: unknown,
  caller: CallerName = "super_admin",
  raw?: string
) {
  return new NextRequest("http://localhost/api/admin/x", {
    method,
    headers: { "content-type": "application/json", ...authAs(caller) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db = new FakeDatabase({
    password_policy: [],
    permissions: [
      { id: "p-play", code: "can_play" },
      { id: "p-roles", code: "admin_manage_roles" },
    ],
    entitlement_groups: [
      { id: "g-basic", code: "basic", display_name: "Basic", is_active: false },
      { id: "g-power", code: "power", display_name: "Power", is_active: false },
    ],
    entitlement_permissions: [
      { entitlement_group_id: "g-basic", permission_id: "p-play" },
      { entitlement_group_id: "g-power", permission_id: "p-roles" },
    ],
    user_entitlements: [
      { entitlement_group_id: "g-basic", revoked_at: null },
      { entitlement_group_id: "g-basic", revoked_at: null },
      { entitlement_group_id: "g-power", revoked_at: "2026-01-01" },
    ],
  });
  (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
});

describe("password-policy route", () => {
  it("GET returns the defaults when no policy is stored", async () => {
    const body = await (await pwGET(req("GET"))).json();
    expect(body.policy.minLength).toBe(12);
  });

  it("GET returns the stored policy", async () => {
    db.rows("password_policy").push({
      role_id: null,
      user_id: null,
      min_length: 16,
      rotation_days: 0,
      require_uppercase: true,
      require_lowercase: true,
      require_number: true,
      require_special: false,
      password_history_count: 3,
    });
    const body = await (await pwGET(req("GET"))).json();
    expect(body.policy).toMatchObject({
      minLength: 16,
      rotationDays: 0,
      requireSpecial: false,
    });
  });

  it("PUT changes the sent fields and records the verified admin", async () => {
    const res = await pwPUT(req("PUT", { minLength: 14 }));
    expect(res.status).toBe(200);
    expect(db.rows("password_policy")[0]).toMatchObject({
      min_length: 14,
      rotation_days: 90,
    });
    expect(db.rows("audit_log")[0]).toMatchObject({
      actor_id: CALLERS.super_admin.userId,
    });
  });

  it.each([
    [{ minLength: 3 }],
    [{ minLength: "16" }],
    [{ rotationDays: -5 }],
    [{ requireNumber: "yes" }],
    [{ unknownField: 1 }],
  ])("PUT refuses %p and writes nothing", async (body) => {
    const res = await pwPUT(req("PUT", body));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("request.invalid_value");
    expect(db.rows("password_policy")).toHaveLength(0);
  });

  it.each([
    ["a malformed body", undefined, "{nope"],
    ["an array", [], undefined],
    ["null", null, undefined],
  ])("PUT returns 400 for %s", async (_label, body, raw) => {
    const res = await pwPUT(req("PUT", body, "super_admin", raw));
    expect(res.status).toBe(400);
  });

  it("PUT returns 500 when the policy cannot be stored", async () => {
    db.failWrites("password_policy");
    const res = await pwPUT(req("PUT", { minLength: 14 }));
    expect(res.status).toBe(500);
    expect(db.rows("audit_log").map((r) => r.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
  });

  it.each([
    "anonymous",
    "free",
    "moderator",
    "safety_approver",
    "admin",
    "suspended_super_admin",
  ] as const)("refuses %s", async (caller) => {
    expect([401, 403]).toContain(
      (await pwPUT(req("PUT", { minLength: 14 }, caller))).status
    );
    expect(db.rows("password_policy")).toHaveLength(0);
  });
});

describe("entitlements route", () => {
  it("GET returns groups with their active holders", async () => {
    const body = await (await entGET(req("GET", undefined, "admin"))).json();
    const basic = body.groups.find((g: { code: string }) => g.code === "basic");
    const power = body.groups.find((g: { code: string }) => g.code === "power");
    expect(basic.userCount).toBe(2);
    expect(power.userCount).toBe(0);
  });

  it("PATCH turns on a group whose permissions the admin holds", async () => {
    const res = await entPATCH(
      req("PATCH", { groupId: "g-basic", isActive: true }, "admin")
    );
    expect(res.status).toBe(200);
    expect(db.rows("entitlement_groups").find((g) => g.id === "g-basic")?.is_active).toBe(
      true
    );
    expect(db.rows("audit_log")[0]).toMatchObject({ actor_id: CALLERS.admin.userId });
  });

  it("PATCH refuses a group granting a permission the admin lacks (TASK-145)", async () => {
    const res = await entPATCH(
      req("PATCH", { groupId: "g-power", isActive: true }, "admin")
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.grant_exceeds_own");
    expect(db.rows("entitlement_groups").find((g) => g.id === "g-power")?.is_active).toBe(
      false
    );
  });

  it("PATCH lets super_admin turn on that group", async () => {
    const res = await entPATCH(req("PATCH", { groupId: "g-power", isActive: true }));
    expect(res.status).toBe(200);
  });

  it("PATCH returns 404 for an unknown group", async () => {
    const res = await entPATCH(req("PATCH", { groupId: "g-none", isActive: true }));
    expect(res.status).toBe(404);
  });

  it.each([
    [{ isActive: true }],
    [{ groupId: "g-basic", isActive: "true" }],
    [{ groupId: ["g-basic"], isActive: true }],
  ])("PATCH returns 400 for %p", async (body) => {
    expect((await entPATCH(req("PATCH", body))).status).toBe(400);
  });

  it("PATCH returns 400 for a malformed body", async () => {
    expect((await entPATCH(req("PATCH", undefined, "super_admin", "{x"))).status).toBe(
      400
    );
  });

  it.each([
    "anonymous",
    "free",
    "moderator",
    "safety_approver",
    "suspended_super_admin",
  ] as const)("refuses %s", async (caller) => {
    const res = await entPATCH(
      req("PATCH", { groupId: "g-basic", isActive: true }, caller)
    );
    expect([401, 403]).toContain(res.status);
    expect(db.rows("entitlement_groups").every((g) => g.is_active === false)).toBe(true);
  });
});

describe("gdpr purge route", () => {
  const execute = jest.fn();
  beforeEach(() => {
    execute.mockReset().mockResolvedValue({
      purgeId: "pg1",
      status: "completed",
      totalDeleted: 3,
      steps: [{ handler: "db", success: true, deletedCount: 3 }],
    });
    MockPurgePipeline.mockImplementation(() => ({ execute }));
  });

  const purge = (
    caller: CallerName = "super_admin",
    body: unknown = {
      userId: "00000000-0000-4000-8000-00000000b001",
      reason: "admin-action",
    }
  ) => gdprPOST(req("POST", body, caller));

  it("purges for a super_admin, recording them as the requester", async () => {
    const res = await purge();
    expect(res.status).toBe(200);
    expect((await res.json()).purgeId).toBe("pg1");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: CALLERS.super_admin.userId })
    );
  });

  it.each([
    "anonymous",
    "free",
    "moderator",
    "safety_approver",
    "admin",
    "suspended_super_admin",
  ] as const)(
    "refuses %s (audit X-15: an ordinary admin could erase any account)",
    async (caller) => {
      const res = await purge(caller);
      expect([401, 403]).toContain(res.status);
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("refuses a super_admin purging their own account through the admin route", async () => {
    const res = await purge("super_admin", {
      userId: CALLERS.super_admin.userId,
      reason: "admin-action",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("admin.self_target");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to purge another super_admin", async () => {
    const PEER = "00000000-0000-4000-8000-00000000f00d";
    db.tables.users = [
      { id: PEER, cognito_sub: "s", role_id: "r-super", deleted_at: null },
    ];
    db.tables.roles = [{ id: "r-super", name: "super_admin" }];
    db.tables.role_permissions = [];
    const res = await purge("super_admin", { userId: PEER, reason: "admin-action" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.role_protected");
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers 503, not success, when no purge handler ran", async () => {
    execute.mockResolvedValue({
      purgeId: "pg2",
      status: "failed",
      totalDeleted: 0,
      steps: [],
    });
    const res = await purge();
    expect(res.status).toBe(503);
  });

  it.each([
    ["invalid JSON", undefined, "{not json"],
    ["a missing userId", { reason: "admin-action" }, undefined],
    [
      "an invalid reason",
      { userId: "00000000-0000-4000-8000-00000000b001", reason: "nope" },
      undefined,
    ],
  ])("400s on %s", async (_label, body, raw) => {
    const res = await gdprPOST(req("POST", body, "super_admin", raw));
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("500s when the pipeline throws", async () => {
    execute.mockRejectedValue(new Error("pipeline down"));
    expect((await purge()).status).toBe(500);
  });
});

describe("when the audit log is unavailable (audit X-8)", () => {
  beforeEach(() => db.failWrites("audit_log"));

  it("does not change the password policy", async () => {
    const res = await pwPUT(req("PUT", { minLength: 14 }));
    expect(res.status).toBe(503);
    expect(db.rows("password_policy")).toHaveLength(0);
  });

  it("does not toggle an entitlement group", async () => {
    const res = await entPATCH(req("PATCH", { groupId: "g-basic", isActive: true }));
    expect(res.status).toBe(503);
    expect(db.rows("entitlement_groups").every((g) => g.is_active === false)).toBe(true);
  });

  it("does not run a purge", async () => {
    const execute = jest.fn();
    MockPurgePipeline.mockImplementation(() => ({ execute }));
    const res = await gdprPOST(
      req("POST", {
        userId: "00000000-0000-4000-8000-00000000b001",
        reason: "admin-action",
      })
    );
    expect(res.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("read failures stop a privileged change (release review, Sprint 7X)", () => {
  it("entitlements: an unreadable permission list is not an empty one", async () => {
    db.failReads("entitlement_permissions");
    const res = await entPATCH(
      req("PATCH", { groupId: "g-power", isActive: true }, "admin")
    );
    expect(res.status).toBe(503);
    expect(db.rows("entitlement_groups").every((g) => g.is_active === false)).toBe(true);
  });

  describe("users PATCH (role change)", () => {
    const TARGET = "00000000-0000-4000-8000-00000000d001";
    beforeEach(() => {
      db = new FakeDatabase({
        audit_log: [],
        permissions: [{ id: "p-play", code: "can_play" }],
        roles: [
          { id: "r-free", name: "free" },
          { id: "r-super", name: "super_admin" },
        ],
        role_permissions: [{ role_id: "r-free", permission_id: "p-play" }],
        users: [
          { id: TARGET, cognito_sub: "sub-d", role_id: "r-super", deleted_at: null },
        ],
      });
      (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
    });

    it.each(["roles", "role_permissions", "users"])(
      "answers 503 and changes nothing when %s cannot be read",
      async (table) => {
        db.failReads(table);
        const res = await usersPATCH(
          req("PATCH", { userId: TARGET, roleId: "r-free" }, "admin")
        );
        expect(res.status).toBe(503);
        expect(db.rows("users")[0].role_id).toBe("r-super");
        expect(db.writes).toEqual([]);
      }
    );

    it("refuses to demote a super_admin when the rules can read the role", async () => {
      const res = await usersPATCH(
        req("PATCH", { userId: TARGET, roleId: "r-free" }, "admin")
      );
      expect(res.status).toBe(403);
      expect(db.rows("users")[0].role_id).toBe("r-super");
    });
  });
});
