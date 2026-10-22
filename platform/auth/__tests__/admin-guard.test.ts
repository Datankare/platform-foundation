/**
 * platform/auth/__tests__/admin-guard.test.ts — requireAdmin and adminGuard
 *
 * The guard is the one gate in front of every admin route. Each real role is sent against each
 * admin permission (helpers/test-identities.ts), so the test fails if any role can pass a check
 * its real permissions do not allow, if a suspended or banned staff member keeps any power
 * (audit X-6), or if the development bypass can switch on in a production build.
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
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { NextRequest, NextResponse } from "next/server";
import {
  authAs,
  CALLERS,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  type CallerName,
} from "@/__tests__/helpers/test-identities";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { enforceRateLimit } from "@/platform/rate-limit";
import { isInGoodStanding } from "@/platform/auth/account-status-guard";
import { getCachedPermissions } from "@/platform/auth/permissions-cache";

const req = (caller: CallerName) =>
  new NextRequest("http://localhost/api/admin/x", { headers: authAs(caller) });

const ROLES = Object.keys(CALLERS).filter(
  (c) => c !== "suspended_super_admin"
) as Exclude<keyof typeof CALLERS, "suspended_super_admin">[];

describe("requireAdmin — every role against every permission", () => {
  const cases = ROLES.flatMap((role) =>
    PERMISSION_CATALOG.map((p) => [role, p] as const)
  );

  it.each(cases)("%s and %s", async (role, permission) => {
    const result = await requireAdmin(req(role), permission);
    const allowed = ROLE_PERMISSIONS[CALLERS[role].roleName].includes(permission);
    if (allowed) {
      expect(result.admin).toEqual({
        userId: CALLERS[role].userId,
        sub: CALLERS[role].sub,
        roleName: CALLERS[role].roleName,
        permissions: expect.arrayContaining([permission]),
      });
    } else {
      expect(result.error?.status).toBe(403);
      expect((await result.error!.json()).code).toBe("auth.permission_denied");
    }
  });
});

describe("requireAdmin — refusals", () => {
  it("refuses an anonymous caller with 401", async () => {
    const result = await requireAdmin(req("anonymous"), "can_access_admin");
    expect(result.error?.status).toBe(401);
  });

  it.each(PERMISSION_CATALOG)(
    "refuses a suspended super_admin %s (audit X-6)",
    async (permission) => {
      const result = await requireAdmin(req("suspended_super_admin"), permission);
      expect(result.error?.status).toBe(403);
      expect((await result.error!.json()).code).toBe("account.restricted");
    }
  );

  it("checks standing by the verified user id", async () => {
    await requireAdmin(req("super_admin"), "can_access_admin");
    expect(isInGoodStanding).toHaveBeenCalledWith(CALLERS.super_admin.userId);
  });

  it("refuses a permission code that does not exist", async () => {
    const result = await requireAdmin(req("super_admin"), "admin_everything");
    expect(result.error?.status).toBe(403);
  });

  it.each([
    ["the permission lookup", () => getCachedPermissions as jest.Mock],
    ["the standing lookup", () => isInGoodStanding as jest.Mock],
  ])(
    "answers a coded 503, never access, when %s throws (found by the monkey run)",
    async (_label, mock) => {
      mock().mockRejectedValueOnce(new Error("Missing Supabase environment variables"));
      const result = await requireAdmin(req("super_admin"), "can_access_admin");
      expect(result.admin).toBeUndefined();
      expect(result.error?.status).toBe(503);
      expect(await result.error!.json()).toMatchObject({
        code: "service.unavailable",
        params: { service: "permissions" },
      });
    }
  );

  it("returns the rate limiter's response before verifying anything", async () => {
    (enforceRateLimit as jest.Mock).mockResolvedValueOnce(
      NextResponse.json({ code: "rate.limited" }, { status: 429 })
    );
    const result = await requireAdmin(req("super_admin"), "can_access_admin");
    expect(result.error?.status).toBe(429);
  });
});

describe("adminGuard", () => {
  it("returns null when allowed and the error when not", async () => {
    await expect(adminGuard(req("admin"), "admin_manage_users")).resolves.toBeNull();
    expect((await adminGuard(req("admin"), "admin_manage_roles"))?.status).toBe(403);
  });
});

describe("development bypass", () => {
  const load = (env: Record<string, string>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let mod: typeof import("@/platform/auth/admin-guard") | undefined;
    jest.isolateModules(() => {
      mod = require("@/platform/auth/admin-guard");
    });
    process.env = saved;
    return mod!;
  };

  it("admits the nil-id bypass admin only outside production", async () => {
    const dev = load({ ADMIN_DEV_BYPASS: "true", NODE_ENV: "development" });
    const result = await dev.requireAdmin(req("anonymous"), "admin_manage_roles");
    expect(result.admin?.userId).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("never admits it in a production build", async () => {
    const prod = load({ ADMIN_DEV_BYPASS: "true", NODE_ENV: "production" });
    const result = await prod.requireAdmin(req("anonymous"), "admin_manage_roles");
    expect(result.error?.status).toBe(401);
  });
});
