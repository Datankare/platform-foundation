/**
 * Permissions engine, cache, entitlements, and audit tests.
 *
 * Uses per-query mock responses instead of shared chain mocks.
 */

// Track all queries and return canned responses
const queryLog: { table: string; method: string; args: any[] }[] = [];
let queryResponses: Record<string, any> = {};

function createQueryBuilder(table: string) {
  const builder: any = {};
  const methods = [
    "select",
    "insert",
    "update",
    "upsert",
    "eq",
    "in",
    "is",
    "or",
    "order",
    "limit",
    "single",
  ];
  for (const method of methods) {
    builder[method] = (...args: any[]) => {
      queryLog.push({ table, method, args });
      if (method === "single") {
        return Promise.resolve(
          queryResponses[`${table}:single`] || { data: null, error: null }
        );
      }
      // Terminal methods that return data
      if (queryResponses[`${table}:${method}:${JSON.stringify(args)}`]) {
        return Promise.resolve(
          queryResponses[`${table}:${method}:${JSON.stringify(args)}`]
        );
      }
      // Check for table-level terminal response
      if (queryResponses[`${table}:data`]) {
        const resp = queryResponses[`${table}:data`];
        // Return a thenable that also has chain methods
        const thenable: any = Promise.resolve(resp);
        for (const m of methods) {
          thenable[m] = builder[m];
        }
        return thenable;
      }
      return builder;
    };
  }
  // Make builder thenable for queries that end without single()
  builder.then = (resolve: any, reject: any) => {
    const resp = queryResponses[`${table}:data`] || { data: [], error: null };
    return Promise.resolve(resp).then(resolve, reject);
  };
  return builder;
}

const mockFrom = jest.fn((table: string) => createQueryBuilder(table));

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: () => ({ from: mockFrom }),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: () => "test-req-id",
}));

beforeEach(() => {
  jest.clearAllMocks();
  queryLog.length = 0;
  queryResponses = {};
});

// ── Permissions Engine Tests ────────────────────────────────────────────

describe("resolvePermissions", () => {
  it("returns null when player not found", async () => {
    queryResponses["players:single"] = { data: null, error: { message: "Not found" } };
    const { resolvePermissions } = await import("@/platform/auth/permissions");
    const result = await resolvePermissions("unknown-sub");
    expect(result).toBeNull();
  });
});

// ── Permissions Cache Tests ─────────────────────────────────────────────

describe("permissions cache", () => {
  it("getCacheStats returns initial state", async () => {
    const { getCacheStats, clearPermissionsCache } =
      await import("@/platform/auth/permissions-cache");
    clearPermissionsCache();
    const stats = getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.maxSize).toBe(10000);
    expect(stats.ttlMs).toBe(60000);
  });

  it("invalidatePermissions removes entry", async () => {
    const { invalidatePermissions, clearPermissionsCache, getCacheStats } =
      await import("@/platform/auth/permissions-cache");
    clearPermissionsCache();
    invalidatePermissions("nonexistent");
    expect(getCacheStats().size).toBe(0);
  });

  it("clearPermissionsCache empties the cache", async () => {
    const { clearPermissionsCache, getCacheStats } =
      await import("@/platform/auth/permissions-cache");
    clearPermissionsCache();
    expect(getCacheStats().size).toBe(0);
  });
});

// ── Audit Log Tests ─────────────────────────────────────────────────────

describe("writeAuditLog", () => {
  it("calls from(audit_log) with insert", async () => {
    queryResponses["audit_log:data"] = { error: null };
    const { writeAuditLog } = await import("@/platform/auth/audit");

    await writeAuditLog({
      action: "role_changed",
      actorId: "admin-1",
      targetId: "player-1",
      details: { oldRole: "free", newRole: "monthly" },
    });

    expect(mockFrom).toHaveBeenCalledWith("audit_log");
  });

  it("does not throw on write failure", async () => {
    queryResponses["audit_log:data"] = { error: { message: "DB connection failed" } };
    const { writeAuditLog } = await import("@/platform/auth/audit");

    await expect(
      writeAuditLog({ action: "login_success", actorId: "player-1" })
    ).resolves.toBeUndefined();
  });
});

// ── Entitlements Tests ──────────────────────────────────────────────────

describe("grantEntitlement", () => {
  it("calls from(player_entitlements) with upsert", async () => {
    queryResponses["player_entitlements:data"] = { error: null };
    queryResponses["audit_log:data"] = { error: null };

    const { grantEntitlement } = await import("@/platform/auth/entitlements");
    const result = await grantEntitlement({
      playerId: "player-1",
      entitlementGroupId: "group-1",
      grantedBy: "admin-1",
      expiresAt: "2026-12-31T23:59:59Z",
    });

    expect(result.success).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith("player_entitlements");
  });
});

describe("revokeEntitlement", () => {
  it("calls from(player_entitlements) with update", async () => {
    queryResponses["player_entitlements:data"] = { error: null };
    queryResponses["audit_log:data"] = { error: null };

    const { revokeEntitlement } = await import("@/platform/auth/entitlements");
    const result = await revokeEntitlement({
      playerId: "player-1",
      entitlementGroupId: "group-1",
      revokedBy: "admin-1",
    });

    expect(result.success).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith("player_entitlements");
  });
});

describe("getPlayerEntitlements", () => {
  it("returns empty array when player has no entitlements", async () => {
    queryResponses["player_entitlements:data"] = { data: [], error: null };

    const { getPlayerEntitlements } = await import("@/platform/auth/entitlements");
    const result = await getPlayerEntitlements("player-1");

    expect(result).toHaveLength(0);
  });
});
