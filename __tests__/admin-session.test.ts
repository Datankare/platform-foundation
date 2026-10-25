/**
 * __tests__/admin-session.test.ts — GET /api/admin/session (audit B-14, A-9)
 *
 * The console showed every section to every admin (hasPermission was always true). It now asks
 * the server who it is open for: the real guard and roles, each caller's own permissions only.
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

import { NextRequest } from "next/server";
import {
  authAs,
  CALLERS,
  ROLE_PERMISSIONS,
  type CallerName,
} from "@/__tests__/helpers/test-identities";
import { GET } from "@/app/api/admin/session/route";

const get = (caller: CallerName) =>
  GET(new NextRequest("http://localhost/api/admin/session", { headers: authAs(caller) }));

describe("GET /api/admin/session", () => {
  it.each(["moderator", "safety_approver", "admin", "super_admin"] as const)(
    "answers %s with exactly their own permissions",
    async (caller) => {
      const res = await get(caller);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe(CALLERS[caller].userId);
      expect([...body.permissions].sort()).toEqual(
        [...ROLE_PERMISSIONS[CALLERS[caller].roleName]].sort()
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  );

  it.each([
    ["anonymous", 401, "auth.required"],
    ["free", 403, "auth.permission_denied"],
    ["suspended_super_admin", 403, "account.restricted"],
    ["password_only_super_admin", 403, "auth.mfa_required"],
  ] as const)("refuses %s (%s %s)", async (caller, status, code) => {
    const res = await get(caller);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });
});
