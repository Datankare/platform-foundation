/**
 * Sprint 7a — Integration tests for DB-dependent auth modules
 *
 * Tests audit, entitlements, and permissions with mocked Supabase client.
 * Verifies correct table queries, error handling, and data transformation.
 */

import { createSequentialMockSupabase } from "./helpers/mock-supabase";

// ── Audit Module ────────────────────────────────────────────────────────

describe("writeAuditLog", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("inserts an audit entry with all fields", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { writeAuditLog } = await import("@/platform/auth/audit");

    await writeAuditLog({
      action: "role_changed",
      actorId: "admin-1",
      targetId: "user-1",
      details: { oldRole: "free", newRole: "admin" },
      ipAddress: "1.2.3.4",
      userAgent: "Mozilla/5.0",
    });

    expect(mockClient.from).toHaveBeenCalledWith("audit_log");
    const builder = mockClient._fromCalls[0].builder;
    expect(builder.insert).toHaveBeenCalledWith({
      action: "role_changed",
      actor_id: "admin-1",
      target_id: "user-1",
      details: { oldRole: "free", newRole: "admin" },
      ip_address: "1.2.3.4",
      user_agent: "Mozilla/5.0",
    });
  });

  it("defaults optional fields to null", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { writeAuditLog } = await import("@/platform/auth/audit");

    await writeAuditLog({ action: "login_success" });

    const builder = mockClient._fromCalls[0].builder;
    expect(builder.insert).toHaveBeenCalledWith({
      action: "login_success",
      actor_id: null,
      target_id: null,
      details: {},
      ip_address: null,
      user_agent: null,
    });
  });

  it("does not throw on insert error", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "audit_log",
        response: { data: null, error: { message: "DB error" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { writeAuditLog } = await import("@/platform/auth/audit");

    // Should not throw — fire-and-forget
    await expect(writeAuditLog({ action: "login_failed" })).resolves.toBeUndefined();
  });
});

describe("getAuditLogForUser", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("returns mapped audit entries", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "audit_log",
        response: {
          data: [
            {
              action: "role_changed",
              actor_id: "admin-1",
              target_id: "user-1",
              details: { newRole: "admin" },
              ip_address: "1.2.3.4",
              user_agent: "Mozilla",
              created_at: "2026-03-31T00:00:00Z",
            },
          ],
          error: null,
        },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { getAuditLogForUser } = await import("@/platform/auth/audit");

    const entries = await getAuditLogForUser("user-1");

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("role_changed");
    expect(entries[0].actorId).toBe("admin-1");
    expect(entries[0].targetId).toBe("user-1");
  });

  it("returns empty array on error", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "audit_log",
        response: { data: null, error: { message: "query failed" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { getAuditLogForUser } = await import("@/platform/auth/audit");

    const entries = await getAuditLogForUser("user-1");
    expect(entries).toEqual([]);
  });
});

// ── Entitlements Module ─────────────────────────────────────────────────

describe("grantEntitlement", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("upserts user_entitlements and writes audit log", async () => {
    const mockClient = createSequentialMockSupabase([
      // upsert user_entitlements
      { table: "user_entitlements", response: { data: null, error: null } },
      // writeAuditLog
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { grantEntitlement } = await import("@/platform/auth/entitlements");

    const result = await grantEntitlement({
      userId: "p1",
      entitlementGroupId: "eg1",
      grantedBy: "admin-1",
      expiresAt: "2027-01-01T00:00:00Z",
    });

    expect(result.success).toBe(true);
    expect(mockClient.from).toHaveBeenCalledWith("user_entitlements");
  });

  it("returns error on upsert failure", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "user_entitlements",
        response: { data: null, error: { message: "duplicate key" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { grantEntitlement } = await import("@/platform/auth/entitlements");

    const result = await grantEntitlement({
      userId: "p1",
      entitlementGroupId: "eg1",
      grantedBy: "admin-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("duplicate key");
  });
});

describe("revokeEntitlement", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("sets revoked_at and writes audit log", async () => {
    const mockClient = createSequentialMockSupabase([
      { table: "user_entitlements", response: { data: null, error: null } },
      { table: "audit_log", response: { data: null, error: null } },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { revokeEntitlement } = await import("@/platform/auth/entitlements");

    const result = await revokeEntitlement({
      userId: "p1",
      entitlementGroupId: "eg1",
      revokedBy: "admin-1",
    });

    expect(result.success).toBe(true);
    const builder = mockClient._fromCalls[0].builder;
    expect(builder.update).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("user_id", "p1");
  });
});

// ── Permissions Module ──────────────────────────────────────────────────

describe("resolvePermissions", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("returns null when user not found", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "users",
        response: { data: null, error: { message: "not found" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { resolvePermissions } = await import("@/platform/auth/permissions");

    const result = await resolvePermissions("nonexistent-sub");
    expect(result).toBeNull();
  });

  it("queries correct tables in sequence", async () => {
    const mockClient = createSequentialMockSupabase([
      // 1. Get user
      {
        table: "users",
        response: { data: { id: "p1", role_id: "r1" }, error: null },
      },
      // 2. Get role name
      {
        table: "roles",
        response: { data: { name: "admin" }, error: null },
      },
      // 3. Get role permissions
      {
        table: "role_permissions",
        response: {
          data: [{ permission_id: "perm1" }, { permission_id: "perm2" }],
          error: null,
        },
      },
      // 4. Get inherited roles
      {
        table: "role_inheritance",
        response: { data: [], error: null },
      },
      // 5. Get user entitlements
      {
        table: "user_entitlements",
        response: { data: [], error: null },
      },
      // 6. Resolve permission codes
      {
        table: "permissions",
        response: {
          data: [{ code: "can_play" }, { code: "can_manage_roles" }],
          error: null,
        },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { resolvePermissions } = await import("@/platform/auth/permissions");

    const result = await resolvePermissions("test-sub");

    expect(result).not.toBeNull();
    expect(result!.userId).toBe("p1");
    expect(result!.roleName).toBe("admin");
    expect(result!.permissions).toContain("can_play");
    expect(result!.permissions).toContain("can_manage_roles");
    expect(result!.entitlementGroups).toEqual([]);
  });
});

describe("hasPermission", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("returns false when user not found", async () => {
    const mockClient = createSequentialMockSupabase([
      {
        table: "users",
        response: { data: null, error: { message: "not found" } },
      },
    ]);

    jest.doMock("@/lib/supabase/server", () => ({
      getSupabaseServiceClient: () => mockClient,
    }));

    const { hasPermission } = await import("@/platform/auth/permissions");

    const result = await hasPermission("nonexistent", "can_play");
    expect(result).toBe(false);
  });
});
