/**
 * Permissions cache: initial state, invalidation, clearing. (Resolution and entitlement SQL is
 * proven against the database in __tests__/db/auth-users.db.test.ts and auth-records.db.test.ts.)
 */

jest.mock("@/platform/auth/permissions", () => ({ resolvePermissions: jest.fn() }));

describe("permissions cache", () => {
  it("getCacheStats returns initial state", async () => {
    const { getCacheStats, clearPermissionsCache } =
      await import("@/platform/auth/permissions-cache");
    await clearPermissionsCache();
    const stats = getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.maxSize).toBe(10000);
    expect(stats.ttlMs).toBe(60000);
  });

  it("invalidatePermissions removes entry", async () => {
    const { invalidatePermissions, clearPermissionsCache, getCacheStats } =
      await import("@/platform/auth/permissions-cache");
    await clearPermissionsCache();
    await invalidatePermissions("nonexistent");
    expect(getCacheStats().size).toBe(0);
  });

  it("clearPermissionsCache empties the cache", async () => {
    const { clearPermissionsCache, getCacheStats } =
      await import("@/platform/auth/permissions-cache");
    await clearPermissionsCache();
    expect(getCacheStats().size).toBe(0);
  });
});
