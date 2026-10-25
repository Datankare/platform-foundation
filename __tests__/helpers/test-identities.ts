/**
 * __tests__/helpers/test-identities.ts — Real roles for authorization tests, with the real guard
 *
 * Adversarial Validation practice 5: a test that asserts authorization never stubs the guard it
 * asserts. Instead of mocking platform/auth/admin-guard, a test mocks only what sits beneath it —
 * token verification, the permission lookup and the account-standing lookup — with callers whose
 * permissions are exactly what their real role holds (scripts/role-catalog.cjs, checked against
 * the replayed database in CI). The guard itself, its permission check and its standing check run
 * as in production.
 *
 * Usage, at the top of a test file:
 *
 *   jest.mock("@/platform/auth/middleware", () =>
 *     require("@/__tests__/helpers/test-identities").mockMiddleware());
 *   jest.mock("@/platform/auth/permissions-cache", () =>
 *     require("@/__tests__/helpers/test-identities").mockPermissionsCache());
 *   jest.mock("@/platform/auth/account-status-guard", () =>
 *     require("@/__tests__/helpers/test-identities").mockAccountStatus());
 *   jest.mock("@/platform/rate-limit", () =>
 *     require("@/__tests__/helpers/test-identities").mockRateLimit());
 *
 * then send requests with `headers: authAs("moderator")`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const { loadRoleCatalog } = require("../../scripts/role-catalog.cjs") as {
  loadRoleCatalog: () => {
    permissions: string[];
    effective: Record<string, string[]>;
  };
};

const catalog = loadRoleCatalog();

/** Every permission code the migrations create. */
export const PERMISSION_CATALOG: readonly string[] = catalog.permissions;

/** Each role's effective permissions, as the database resolves them. */
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> =
  catalog.effective;

export interface TestIdentity {
  readonly name: string;
  readonly sub: string;
  readonly userId: string;
  readonly roleName: string;
  readonly permissions: readonly string[];
  /** False for a restricted, suspended or banned account. */
  readonly inGoodStanding: boolean;
  /** Whether the identity signs in with a second factor (audit A-9); true unless set. */
  readonly mfaEnabled: boolean;
}

// Shared through globalThis so a test that calls jest.resetModules() — which loads a fresh copy
// of this module for the mocked middleware — still resolves the callers it created.
const registry: Map<string, TestIdentity> = ((globalThis as any).__TEST_IDENTITIES__ ??=
  new Map<string, TestIdentity>());

/** A stable 12-hex-digit suffix for a caller name, so ids are the same in every module copy. */
function suffix(name: string): string {
  let h = 0x811c9dc5;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h.toString(16) + name.length.toString(16).padStart(4, "0"))
    .padStart(12, "0")
    .slice(-12);
}

/** A caller holding exactly `role`'s permissions. Names must be unique per identity. */
export function identityFor(
  role: string,
  options: { name?: string; inGoodStanding?: boolean; mfaEnabled?: boolean } = {}
): TestIdentity {
  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) throw new Error(`No role "${role}" in the catalog`);
  const name = options.name ?? role;
  const n = suffix(name);
  const identity: TestIdentity = {
    name,
    sub: `test-sub-${n}`,
    userId: `00000000-0000-4000-9000-${n}`,
    roleName: role,
    permissions,
    inGoodStanding: options.inGoodStanding ?? true,
    mfaEnabled: options.mfaEnabled ?? true,
  };
  registry.set(identity.sub, identity);
  return identity;
}

/** One caller per real role, plus a suspended super_admin. */
export const CALLERS = {
  guest: identityFor("guest"),
  free: identityFor("free"),
  moderator: identityFor("moderator"),
  safety_approver: identityFor("safety_approver"),
  admin: identityFor("admin"),
  super_admin: identityFor("super_admin"),
  suspended_super_admin: identityFor("super_admin", {
    name: "suspended_super_admin",
    inGoodStanding: false,
  }),
  /** A super_admin who signs in with a password only (audit A-9). */
  password_only_super_admin: identityFor("super_admin", {
    name: "password_only_super_admin",
    mfaEnabled: false,
  }),
} as const;

export type CallerName = keyof typeof CALLERS | "anonymous";

/** The test caller with this token subject, if any. */
export function identityForSub(sub: string): TestIdentity | undefined {
  return registry.get(sub);
}

/** Request headers that authenticate as `caller` (none for "anonymous"). */
export function authAs(caller: CallerName | TestIdentity): Record<string, string> {
  if (caller === "anonymous") return {};
  const identity = typeof caller === "string" ? CALLERS[caller] : caller;
  return { authorization: `Bearer test-token:${identity.sub}` };
}

function identityFromRequest(request: any): TestIdentity | undefined {
  const header: string | null = request?.headers?.get?.("authorization") ?? null;
  const match = header?.match(/^Bearer test-token:(.+)$/);
  return match ? registry.get(match[1]) : undefined;
}

/** platform/auth/middleware with token verification replaced by the test callers. */
export function mockMiddleware(): any {
  const actual = jest.requireActual("@/platform/auth/middleware");
  const { apiError } = jest.requireActual("@/platform/errors");
  return {
    ...actual,
    requireAuth: jest.fn(async (request: any) => {
      const identity = identityFromRequest(request);
      if (!identity) return { error: apiError("auth.required", { request }) };
      return {
        user: {
          sub: identity.sub,
          email: `${identity.name}@test`,
          mfaEnabled: identity.mfaEnabled,
        },
        accessToken: "test",
      };
    }),
  };
}

/** platform/auth/permissions-cache answering from the callers' real role permissions. */
export function mockPermissionsCache(): any {
  const actual = jest.requireActual("@/platform/auth/permissions-cache");
  const lookup = async (sub: string) => {
    const identity = registry.get(sub);
    if (!identity) return null;
    return {
      userId: identity.userId,
      roleId: `role-${identity.roleName}`,
      roleName: identity.roleName,
      permissions: [...identity.permissions],
      entitlementGroups: [],
    };
  };
  return {
    ...actual,
    getCachedPermissions: jest.fn(lookup),
    hasCachedPermission: jest.fn(
      async (sub: string, code: string) =>
        (await lookup(sub))?.permissions.includes(code) ?? false
    ),
    invalidatePermissions: jest.fn(),
  };
}

/** platform/auth/account-status-guard answering from the callers' standing. */
export function mockAccountStatus(): any {
  const actual = jest.requireActual("@/platform/auth/account-status-guard");
  return {
    ...actual,
    isInGoodStanding: jest.fn(async (userId: string) => {
      for (const identity of registry.values()) {
        if (identity.userId === userId) return identity.inGoodStanding;
      }
      return false;
    }),
  };
}

/** platform/rate-limit that never limits (rate limiting has its own tests). */
export function mockRateLimit(): any {
  const actual = jest.requireActual("@/platform/rate-limit");
  return {
    ...actual,
    enforceRateLimit: jest.fn(async () => null),
    enforceDailyPaidQuota: jest.fn(async () => null),
  };
}
