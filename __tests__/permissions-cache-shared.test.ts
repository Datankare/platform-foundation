/**
 * __tests__/permissions-cache-shared.test.ts — an invalidation reaches every instance (audit RR-9)
 *
 * The permissions cache is per instance: a demotion took up to its 60-second lifetime to take
 * effect on the other instances. An invalidation is now also a stamp in the shared cache, and an
 * entry older than a stamp is not served. Two copies of the module stand for two instances (each
 * has its own entries; the shared cache is one, as Upstash is).
 */

const mockResolve = jest.fn();
jest.mock("@/platform/auth/permissions", () => ({
  resolvePermissions: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getCache, resetCache } from "@/platform/cache";

type CacheModule = typeof import("@/platform/auth/permissions-cache");

/** A fresh copy of the module: another instance, with its own entries. */
function instance(): CacheModule {
  let mod = undefined as CacheModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<CacheModule>("@/platform/auth/permissions-cache");
  });
  return mod!;
}

const perms = (role: string, permissions: string[]) => ({
  userId: "u1",
  roleId: `role-${role}`,
  roleName: role,
  permissions,
  entitlementGroups: [],
});

beforeEach(() => {
  resetCache();
  mockResolve.mockReset();
});

describe("permissions cache across instances (RR-9)", () => {
  it("a demotion on one instance takes effect on another at its next request", async () => {
    const a = instance();
    const b = instance();
    mockResolve.mockResolvedValue(perms("admin", ["admin_manage_roles"]));
    expect(await a.hasCachedPermission("sub-1", "admin_manage_roles")).toBe(true);
    expect(await b.hasCachedPermission("sub-1", "admin_manage_roles")).toBe(true);
    expect(mockResolve).toHaveBeenCalledTimes(2);

    // Cached on both: no further resolution.
    await b.hasCachedPermission("sub-1", "admin_manage_roles");
    expect(mockResolve).toHaveBeenCalledTimes(2);

    // Demoted, and invalidated on A only.
    mockResolve.mockResolvedValue(perms("free", []));
    await a.invalidatePermissions("sub-1");
    expect(await b.hasCachedPermission("sub-1", "admin_manage_roles")).toBe(false);
    expect(await a.hasCachedPermission("sub-1", "admin_manage_roles")).toBe(false);
  });

  it("clearing every entry on one instance clears them on another", async () => {
    const a = instance();
    const b = instance();
    mockResolve.mockResolvedValue(perms("admin", ["x"]));
    await b.getCachedPermissions("sub-2");
    mockResolve.mockResolvedValue(perms("free", []));
    await a.clearPermissionsCache();
    expect((await b.getCachedPermissions("sub-2"))?.roleName).toBe("free");
  });

  it("another subject's invalidation leaves an entry cached", async () => {
    const a = instance();
    const b = instance();
    mockResolve.mockResolvedValue(perms("admin", ["x"]));
    await b.getCachedPermissions("sub-3");
    await a.invalidatePermissions("someone-else");
    await b.getCachedPermissions("sub-3");
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it("does not trust an entry when the shared stamps cannot be read", async () => {
    const b = instance();
    mockResolve.mockResolvedValue(perms("admin", ["x"]));
    await b.getCachedPermissions("sub-4");
    const shared = getCache();
    const spy = jest.spyOn(shared, "get").mockRejectedValue(new Error("upstash down"));
    mockResolve.mockResolvedValue(perms("free", []));
    expect((await b.getCachedPermissions("sub-4"))?.roleName).toBe("free");
    spy.mockRestore();
  });

  it("an invalidation that cannot be published still clears this instance", async () => {
    const a = instance();
    mockResolve.mockResolvedValue(perms("admin", ["x"]));
    await a.getCachedPermissions("sub-5");
    const spy = jest
      .spyOn(getCache(), "set")
      .mockRejectedValue(new Error("upstash down"));
    await expect(a.invalidatePermissions("sub-5")).resolves.toBeUndefined();
    spy.mockRestore();
    mockResolve.mockResolvedValue(perms("free", []));
    expect((await a.getCachedPermissions("sub-5"))?.roleName).toBe("free");
  });
});
