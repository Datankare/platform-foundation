/**
 * Sprint 7a.3 — Integration tests for admin API routes
 *
 * Tests admin routes with mocked Supabase and admin guard.
 * Verifies request handling, response format, and error cases.
 */

import { NextRequest } from "next/server";

// Mock admin guard — always allow in tests
jest.mock("@/platform/auth/admin-guard", () => ({
  adminGuard: jest.fn().mockResolvedValue(null),
}));

// Mock audit log — fire-and-forget
jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

// Mock permissions cache
jest.mock("@/platform/auth/permissions-cache", () => ({
  invalidatePermissions: jest.fn(),
}));

// ── Helper ──────────────────────────────────────────────────────────────

function makeRequest(url: string, method: string = "GET", body?: unknown): NextRequest {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return new NextRequest(`http://localhost:3000${url}`, opts);
}

// ── Roles Route ─────────────────────────────────────────────────────────

describe("GET /api/admin/roles", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation((table: string) => {
        const builder: Record<string, jest.Mock> = {};
        const chain = () => builder;
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
                  code: "can_manage_roles",
                  display_name: "Can Manage Roles",
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

// ── Players Route ───────────────────────────────────────────────────────

describe("GET /api/admin/players", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation((table: string) => {
        const builder: Record<string, jest.Mock> = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.order = jest.fn().mockReturnValue(builder);
        builder.range = jest.fn().mockReturnValue(builder);
        builder.or = jest.fn().mockReturnValue(builder);
        builder.eq = jest.fn().mockReturnValue(builder);

        if (table === "players") {
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

  it("returns players with resolved role names", async () => {
    const { GET } = await import("@/app/api/admin/players/route");
    const req = makeRequest("/api/admin/players");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.players).toHaveLength(1);
    expect(body.players[0].email).toBe("alice@test.com");
    expect(body.players[0].roleName).toBe("admin");
  });
});

describe("PATCH /api/admin/players", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation(() => {
        const builder: Record<string, jest.Mock> = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.update = jest.fn().mockReturnValue(builder);
        builder.eq = jest.fn().mockReturnValue(builder);
        builder.single = jest
          .fn()
          .mockResolvedValue({ data: { role_id: "r-old" }, error: null });
        builder.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: null });
        return builder;
      });

      return {
        getSupabaseServiceClient: () => ({ from: mockFrom }),
      };
    });
  });

  it("returns 400 without playerId", async () => {
    const { PATCH } = await import("@/app/api/admin/players/route");
    const req = makeRequest("/api/admin/players", "PATCH", { roleId: "r1" });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it("returns success for valid role change", async () => {
    const { PATCH } = await import("@/app/api/admin/players/route");
    const req = makeRequest("/api/admin/players", "PATCH", {
      playerId: "p1",
      roleId: "r-new",
    });
    const res = await PATCH(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ── Audit Route ─────────────────────────────────────────────────────────

describe("GET /api/admin/audit", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation(() => {
        const builder: Record<string, jest.Mock> = {};
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

// ── Guest Config Route ──────────────────────────────────────────────────

describe("GET /api/admin/guest-config", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation(() => {
        const builder: Record<string, jest.Mock> = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.eq = jest.fn().mockReturnValue(builder);
        builder.single = jest.fn().mockResolvedValue({
          data: {
            nudge_after_sessions: 3,
            grace_after_sessions: 7,
            lockout_after_sessions: 10,
            guest_token_ttl_hours: 72,
          },
          error: null,
        });
        return builder;
      });

      return {
        getSupabaseServiceClient: () => ({ from: mockFrom }),
      };
    });
  });

  it("returns guest config", async () => {
    const { GET } = await import("@/app/api/admin/guest-config/route");
    const req = makeRequest("/api/admin/guest-config");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.config.nudgeAfterSessions).toBe(3);
    expect(body.config.lockoutAfterSessions).toBe(10);
  });
});

// ── Password Policy Route ───────────────────────────────────────────────

describe("GET /api/admin/password-policy", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("@/lib/supabase/server", () => {
      const mockFrom = jest.fn().mockImplementation(() => {
        const builder: Record<string, jest.Mock> = {};
        builder.select = jest.fn().mockReturnValue(builder);
        builder.is = jest.fn().mockReturnValue(builder);
        builder.single = jest.fn().mockResolvedValue({
          data: {
            min_length: 12,
            rotation_days: 90,
            require_uppercase: true,
            require_lowercase: true,
            require_number: true,
            require_special: true,
            password_history_count: 5,
          },
          error: null,
        });
        return builder;
      });

      return {
        getSupabaseServiceClient: () => ({ from: mockFrom }),
      };
    });
  });

  it("returns password policy", async () => {
    const { GET } = await import("@/app/api/admin/password-policy/route");
    const req = makeRequest("/api/admin/password-policy");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.policy.minLength).toBe(12);
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
        const builder: Record<string, jest.Mock> = {};
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
        } else if (table === "player_entitlements") {
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

  it("returns entitlement groups with player counts", async () => {
    const { GET } = await import("@/app/api/admin/entitlements/route");
    const req = makeRequest("/api/admin/entitlements");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].code).toBe("beta_access");
    expect(body.groups[0].playerCount).toBe(2);
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
