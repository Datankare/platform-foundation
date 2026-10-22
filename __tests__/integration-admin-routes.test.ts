/**
 * Sprint 7a.3 — Integration tests for admin API routes
 *
 * Tests admin routes with mocked Supabase. The admin guard is real: requests are sent as a
 * caller holding super_admin's real permissions (helpers/test-identities.ts), and the abuse
 * cases are sent as the roles that must be refused.
 */

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { FakeDatabase } from "./helpers/fake-database";

jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/test-identities").mockMiddleware()
);
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);

// Permission lookups answer from the callers' real role permissions
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);

// ── Helper ──────────────────────────────────────────────────────────────

function makeRequest(
  url: string,
  method: string = "GET",
  body?: unknown,
  caller: CallerName = "super_admin"
): NextRequest {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...authAs(caller) },
  };
  if (body) opts.body = JSON.stringify(body);
  return new NextRequest(`http://localhost:3000${url}`, opts as never);
}

// ── Roles Route ─────────────────────────────────────────────────────────

describe("GET /api/admin/roles", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation((table: string) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const builder: Record<string, any> = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.order = jest.fn().mockReturnValue(builder);
        builder.eq = jest.fn().mockReturnValue(builder);
        builder.in = jest.fn().mockReturnValue(builder);

        if (table === "roles") {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                {
                  id: "r1",
                  name: "admin",
                  display_name: "Admin",
                  description: "Admin role",
                  created_at: "2026-01-01",
                  updated_at: "2026-01-01",
                },
                {
                  id: "r2",
                  name: "free",
                  display_name: "Free",
                  description: "Free role",
                  created_at: "2026-01-01",
                  updated_at: "2026-01-01",
                },
              ],
              error: null,
            });
        } else if (table === "role_permissions") {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { role_id: "r1", permission_id: "p1" },
                { role_id: "r1", permission_id: "p2" },
                { role_id: "r2", permission_id: "p1" },
              ],
              error: null,
            });
        } else if (table === "permissions") {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                {
                  id: "p1",
                  code: "can_play",
                  display_name: "Can Play",
                  category: "gameplay",
                },
                {
                  id: "p2",
                  code: "admin_manage_roles",
                  display_name: "Manage Roles",
                  category: "admin",
                },
              ],
              error: null,
            });
        } else {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [], error: null });
        }

        return builder;
      });

      return {
        getSupabaseServiceClient: () => ({ from: mockFrom }),
      };
    });
  });

  it("returns roles with permission counts", async () => {
    const { GET } = await import("@/app/api/admin/roles/route");
    const req = makeRequest("/api/admin/roles");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.roles).toHaveLength(2);
    expect(body.roles[0].name).toBe("admin");
    expect(body.roles[0].permissionCount).toBe(2);
    expect(body.roles[1].permissionCount).toBe(1);
  });
});

// ── Users Route ───────────────────────────────────────────────────────

describe("GET /api/admin/users", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation((table: string) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const builder: Record<string, any> = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.order = jest.fn().mockReturnValue(builder);
        builder.range = jest.fn().mockReturnValue(builder);
        builder.or = jest.fn().mockReturnValue(builder);
        builder.eq = jest.fn().mockReturnValue(builder);

        if (table === "users") {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                {
                  id: "p1",
                  email: "alice@test.com",
                  display_name: "Alice",
                  role_id: "r1",
                  created_at: "2026-01-01",
                  deleted_at: null,
                },
              ],
              error: null,
            });
        } else if (table === "roles") {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [{ id: "r1", name: "admin", display_name: "Admin" }],
              error: null,
            });
        } else {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [], error: null });
        }

        return builder;
      });

      return {
        getSupabaseServiceClient: () => ({ from: mockFrom }),
      };
    });
  });

  it("returns users with resolved role names", async () => {
    const { GET } = await import("@/app/api/admin/users/route");
    const req = makeRequest("/api/admin/users");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0].email).toBe("alice@test.com");
    expect(body.users[0].roleName).toBe("admin");
  });
});

describe("PATCH /api/admin/users", () => {
  const TARGET = "00000000-0000-4000-8000-0000000000c1";
  let db: FakeDatabase;

  beforeEach(() => {
    jest.resetModules();
    db = new FakeDatabase({
      permissions: [
        { id: "p-play", code: "can_play" },
        { id: "p-roles", code: "admin_manage_roles" },
      ],
      roles: [
        { id: "r-free", name: "free" },
        { id: "r-mod", name: "moderator" },
        { id: "r-power", name: "power" },
        { id: "r-super", name: "super_admin" },
      ],
      role_permissions: [
        { role_id: "r-free", permission_id: "p-play" },
        { role_id: "r-power", permission_id: "p-roles" },
      ],
      users: [
        {
          id: TARGET,
          email: "t@x.com",
          cognito_sub: "sub-t",
          role_id: "r-free",
          deleted_at: null,
        },
        {
          id: CALLERS.admin.userId,
          email: "admin@x.com",
          cognito_sub: CALLERS.admin.sub,
          role_id: "r-free",
          deleted_at: null,
        },
      ],
    });
    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => db.client(),
    }));
  });

  const patch = async (body: unknown, caller: CallerName = "admin") => {
    const { PATCH } = await import("@/app/api/admin/users/route");
    return PATCH(makeRequest("/api/admin/users", "PATCH", body, caller));
  };
  const roleOf = (id: string) => db.rows("users").find((u) => u.id === id)?.role_id;

  it("returns 400 without userId", async () => {
    const res = await patch({ roleId: "r-mod" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed body", async () => {
    const { PATCH } = await import("@/app/api/admin/users/route");
    const req = new NextRequest("http://localhost:3000/api/admin/users", {
      method: "PATCH",
      body: "{nope",
      headers: { "Content-Type": "application/json", ...authAs("admin") },
    });
    expect((await PATCH(req)).status).toBe(400);
  });

  it("changes the role and records who did it", async () => {
    const res = await patch({ userId: TARGET, roleId: "r-mod" });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(roleOf(TARGET)).toBe("r-mod");
    expect(db.rows("audit_log")[0]).toMatchObject({
      action: "role_changed",
      actor_id: CALLERS.admin.userId,
      target_id: TARGET,
    });
  });

  it.each([
    [
      "an unknown user",
      { userId: "00000000-0000-4000-8000-0000000000ff", roleId: "r-mod" },
      404,
    ],
    ["an unknown role", { userId: TARGET, roleId: "r-ghost" }, 404],
    ["super_admin", { userId: TARGET, roleId: "r-super" }, 403],
    [
      "a role with a permission the admin lacks",
      { userId: TARGET, roleId: "r-power" },
      403,
    ],
  ])("refuses %s and changes nothing", async (_label, body, status) => {
    const res = await patch(body);
    expect(res.status).toBe(status);
    expect(roleOf(TARGET)).toBe("r-free");
  });

  it("refuses an admin changing their own role", async () => {
    const res = await patch({ userId: CALLERS.admin.userId, roleId: "r-mod" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth.role_self_change");
  });

  it.each([
    "anonymous",
    "free",
    "moderator",
    "safety_approver",
    "suspended_super_admin",
  ] as const)("refuses %s", async (caller) => {
    const res = await patch({ userId: TARGET, roleId: "r-mod" }, caller);
    expect([401, 403]).toContain(res.status);
    expect(roleOf(TARGET)).toBe("r-free");
  });
});

// ── Audit Route ─────────────────────────────────────────────────────────

describe("GET /api/admin/audit", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const builder: Record<string, any> = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.order = jest.fn().mockReturnValue(builder);
        builder.range = jest.fn().mockReturnValue(builder);
        builder.or = jest.fn().mockReturnValue(builder);
        builder.then = (resolve: (v: unknown) => void) =>
          resolve({
            data: [
              {
                id: "a1",
                action: "role_changed",
                actor_id: "admin-1",
                target_id: "p1",
                details: { newRole: "admin" },
                created_at: "2026-03-31T00:00:00Z",
              },
            ],
            error: null,
          });
        return builder;
      });

      return {
        getSupabaseServiceClient: () => ({ from: mockFrom }),
      };
    });
  });

  it("returns audit entries with correct mapping", async () => {
    const { GET } = await import("@/app/api/admin/audit/route");
    const req = makeRequest("/api/admin/audit?offset=0");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].action).toBe("role_changed");
    expect(body.entries[0].actorId).toBe("admin-1");
  });
});

// ── Password Policy Route ───────────────────────────────────────────────

describe("GET /api/admin/password-policy", () => {
  beforeEach(() => {
    jest.resetModules();
    const db = new FakeDatabase({
      password_policy: [
        {
          role_id: null,
          user_id: null,
          min_length: 14,
          rotation_days: 90,
          require_uppercase: true,
          require_lowercase: true,
          require_number: true,
          require_special: true,
          password_history_count: 5,
        },
      ],
    });
    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => db.client(),
    }));
  });

  it("returns the stored global password policy", async () => {
    const { GET } = await import("@/app/api/admin/password-policy/route");
    const res = await GET(makeRequest("/api/admin/password-policy"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.policy.minLength).toBe(14);
    expect(body.policy.requireSpecial).toBe(true);
    expect(body.policy.passwordHistoryCount).toBe(5);
  });
});

// ── Entitlements Route ──────────────────────────────────────────────────

describe("GET /api/admin/entitlements", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation((table: string) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const builder: Record<string, any> = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.order = jest.fn().mockReturnValue(builder);
        builder.is = jest.fn().mockReturnValue(builder);
        builder.eq = jest.fn().mockReturnValue(builder);

        if (table === "entitlement_groups") {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                {
                  id: "eg1",
                  code: "beta_access",
                  display_name: "Beta Access",
                  is_active: true,
                },
              ],
              error: null,
            });
        } else if (table === "user_entitlements") {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [{ entitlement_group_id: "eg1" }, { entitlement_group_id: "eg1" }],
              error: null,
            });
        } else {
          builder.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [], error: null });
        }

        return builder;
      });

      return {
        getSupabaseServiceClient: () => ({ from: mockFrom }),
      };
    });
  });

  it("returns entitlement groups with user counts", async () => {
    const { GET } = await import("@/app/api/admin/entitlements/route");
    const req = makeRequest("/api/admin/entitlements");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].code).toBe("beta_access");
    expect(body.groups[0].userCount).toBe(2);
    expect(body.groups[0].isActive).toBe(true);
  });
});

// ── AI Execute Route ────────────────────────────────────────────────────

describe("POST /api/admin/ai/execute", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("returns 400 without actions array", async () => {
    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => ({ from: jest.fn() }),
    }));

    const { POST } = await import("@/app/api/admin/ai/execute/route");
    const req = makeRequest("/api/admin/ai/execute", "POST", {});
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns error for unknown tool", async () => {
    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => ({ from: jest.fn() }),
    }));

    const { POST } = await import("@/app/api/admin/ai/execute/route");
    const req = makeRequest("/api/admin/ai/execute", "POST", {
      actions: [{ tool: "nonexistent_tool", input: {} }],
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].success).toBe(false);
    expect(body.results[0].error).toContain("Unknown tool");
  });
});
