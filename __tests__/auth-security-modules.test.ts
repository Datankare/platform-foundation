/**
 * __tests__/auth-security-modules.test.ts — security modules that were hidden from coverage
 *
 * permissions-cache and the GDPR deletion registry, as pure logic: a failed lookup is never
 * cached as access, entries expire and are invalidated, and a cached permission set is never
 * served in another tenant (ADR-053 D3). The SQL of entitlements, consent and GDPR deletion is
 * proven against the database in __tests__/db/auth-records.db.test.ts.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/platform/auth/permissions", () => ({ resolvePermissions: jest.fn() }));

import { resolvePermissions } from "@/platform/auth/permissions";
import {
  clearPermissionsCache,
  getCacheStats,
  getCachedPermissions,
  hasCachedPermission,
  invalidatePermissions,
} from "@/platform/auth/permissions-cache";
import {
  getDeletionModules,
  registerDeletionModule,
  type DeletionModule,
} from "@/platform/auth/gdpr-deletion";
import { runWithTenant } from "@/platform/tenancy/context";

const USER = "00000000-0000-4000-8000-00000000c001";
const resolve = resolvePermissions as jest.Mock;

const effective = (permissions: string[]) => ({
  userId: USER,
  roleId: "r",
  roleName: "free",
  permissions,
  entitlementGroups: [],
});

beforeEach(async () => {
  jest.clearAllMocks();
  await clearPermissionsCache();
});

describe("permissions cache", () => {
  it("resolves once, then serves from the cache until it expires", async () => {
    resolve.mockResolvedValue(effective(["can_play"]));
    await getCachedPermissions("sub-1");
    await getCachedPermissions("sub-1");
    expect(resolve).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now + 61_000);
    await getCachedPermissions("sub-1");
    expect(resolve).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  it("never caches a failed lookup: the next request asks again", async () => {
    resolve.mockResolvedValueOnce(null).mockResolvedValueOnce(effective(["can_play"]));
    expect(await getCachedPermissions("sub-2")).toBeNull();
    expect(await hasCachedPermission("sub-2", "can_play")).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("propagates a lookup error rather than answering", async () => {
    resolve.mockRejectedValue(new Error("db down"));
    await expect(getCachedPermissions("sub-3")).rejects.toThrow("db down");
  });

  it("refuses a permission the user does not hold, and an unknown user", async () => {
    resolve.mockResolvedValueOnce(effective(["can_play"])).mockResolvedValueOnce(null);
    expect(await hasCachedPermission("sub-4", "admin_manage_roles")).toBe(false);
    expect(await hasCachedPermission("sub-none", "can_play")).toBe(false);
  });

  it("forgets one user on invalidation, everyone on clear", async () => {
    resolve.mockResolvedValue(effective(["can_play"]));
    await getCachedPermissions("a");
    await getCachedPermissions("b");
    await invalidatePermissions("a");
    await getCachedPermissions("a");
    await getCachedPermissions("b");
    expect(resolve).toHaveBeenCalledTimes(3);
    await clearPermissionsCache();
    expect(getCacheStats()).toMatchObject({ size: 0, maxSize: 10_000 });
  });

  it("never serves one tenant's cached permissions in another", async () => {
    const a = {
      tenantId: "00000000-0000-4000-8000-0000000000aa",
      mode: "shared" as const,
    };
    const b = {
      tenantId: "00000000-0000-4000-8000-0000000000bb",
      mode: "shared" as const,
    };
    resolve
      .mockResolvedValueOnce(effective(["admin_manage_roles"]))
      .mockResolvedValueOnce(null);
    expect(
      await runWithTenant(a, () => hasCachedPermission("sub-x", "admin_manage_roles"))
    ).toBe(true);
    expect(
      await runWithTenant(b, () => hasCachedPermission("sub-x", "admin_manage_roles"))
    ).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("invalidates a subject in every tenant", async () => {
    const a = {
      tenantId: "00000000-0000-4000-8000-0000000000aa",
      mode: "shared" as const,
    };
    const b = {
      tenantId: "00000000-0000-4000-8000-0000000000bb",
      mode: "shared" as const,
    };
    resolve.mockResolvedValue(effective(["can_play"]));
    await runWithTenant(a, () => getCachedPermissions("sub-y"));
    await runWithTenant(b, () => getCachedPermissions("sub-y"));
    expect(getCacheStats().size).toBe(2);
    invalidatePermissions("sub-y");
    expect(getCacheStats().size).toBe(0);
  });
});

describe("GDPR deletion registry", () => {
  const mod = (name: string): DeletionModule => ({
    moduleName: name,
    description: name,
    tables: [name],
    softDelete: jest.fn(async () => ({ success: true })),
    hardPurge: jest.fn(async () => ({ success: true })),
  });

  it("replaces a module registered twice under one name", () => {
    registerDeletionModule(mod("dup"));
    registerDeletionModule(mod("dup"));
    expect(getDeletionModules().filter((m) => m.moduleName === "dup")).toHaveLength(1);
  });
});
