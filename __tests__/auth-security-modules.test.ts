/**
 * __tests__/auth-security-modules.test.ts — security modules that were hidden from coverage
 *
 * permissions-cache, entitlements, consent and gdpr-deletion were listed in
 * coveragePathIgnorePatterns, so nothing measured whether their refusals were tested (audit
 * 2026-10, "controls depend on lists nobody verifies"). They are measured now; these tests hold
 * the hostile cases: a failed lookup is never cached as access, an expired, revoked or
 * deactivated entitlement grants nothing, consent fails closed on a read error, every change is
 * recorded before it happens and nothing changes when the audit log is unavailable, and a
 * deletion that half-succeeds reports failure. Real audit module over an in-memory database
 * (helpers/fake-database.ts).
 */

jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/platform/auth/permissions", () => ({ resolvePermissions: jest.fn() }));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { resolvePermissions } from "@/platform/auth/permissions";
import {
  clearPermissionsCache,
  getCacheStats,
  getCachedPermissions,
  hasCachedPermission,
  invalidatePermissions,
} from "@/platform/auth/permissions-cache";
import {
  getUserEntitlements,
  grantEntitlement,
  revokeEntitlement,
} from "@/platform/auth/entitlements";
import {
  getUserConsents,
  grantConsent,
  hasConsent,
  revokeConsent,
} from "@/platform/auth/consent";
import {
  getDeletionModules,
  hardPurgeUser,
  registerDeletionModule,
  softDeleteUser,
  type DeletionModule,
} from "@/platform/auth/gdpr-deletion";
import { FakeDatabase } from "./helpers/fake-database";

const USER = "00000000-0000-4000-8000-00000000c001";
const ADMIN = "00000000-0000-4000-8000-00000000c0a1";
const GROUP = "00000000-0000-4000-8000-00000000c0b1";
const resolve = resolvePermissions as jest.Mock;
let db: FakeDatabase;

function withDb(seed: ConstructorParameters<typeof FakeDatabase>[0] = {}) {
  db = new FakeDatabase({ audit_log: [], ...seed });
  (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
}

const effective = (permissions: string[]) => ({
  userId: USER,
  roleId: "r",
  roleName: "free",
  permissions,
  entitlementGroups: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  clearPermissionsCache();
  withDb();
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
    invalidatePermissions("a");
    await getCachedPermissions("a");
    await getCachedPermissions("b");
    expect(resolve).toHaveBeenCalledTimes(3);
    clearPermissionsCache();
    expect(getCacheStats()).toMatchObject({ size: 0, maxSize: 10_000 });
  });
});

describe("entitlements", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it("grants, recording the grant before it is written", async () => {
    withDb({ user_entitlements: [] });
    const res = await grantEntitlement({
      userId: USER,
      entitlementGroupId: GROUP,
      grantedBy: ADMIN,
    } as Parameters<typeof grantEntitlement>[0]);
    expect(res).toEqual({ success: true });
    expect(db.writes.map(([op, t]) => `${op} ${t}`)).toEqual([
      "insert audit_log",
      "upsert user_entitlements",
    ]);
  });

  it("grants nothing when the audit log is unavailable", async () => {
    withDb({ user_entitlements: [] });
    db.failWrites("audit_log");
    const res = await grantEntitlement({
      userId: USER,
      entitlementGroupId: GROUP,
      grantedBy: ADMIN,
    } as Parameters<typeof grantEntitlement>[0]);
    expect(res).toEqual({ success: false, error: "audit unavailable" });
    expect(db.rows("user_entitlements")).toHaveLength(0);
  });

  it("reports a failed write as a failure", async () => {
    withDb({ user_entitlements: [] });
    db.failWrites("user_entitlements");
    const res = await grantEntitlement({
      userId: USER,
      entitlementGroupId: GROUP,
      grantedBy: ADMIN,
    } as Parameters<typeof grantEntitlement>[0]);
    expect(res.success).toBe(false);
  });

  it("revokes by marking, keeping the record", async () => {
    withDb({
      user_entitlements: [
        { user_id: USER, entitlement_group_id: GROUP, revoked_at: null },
      ],
    });
    const res = await revokeEntitlement({
      userId: USER,
      entitlementGroupId: GROUP,
      revokedBy: ADMIN,
    });
    expect(res).toEqual({ success: true });
    expect(db.rows("user_entitlements")[0]).toMatchObject({ revoked_by: ADMIN });
    expect(db.rows("user_entitlements")[0].revoked_at).toBeTruthy();
  });

  it("revokes nothing when the audit log is unavailable, or the write fails", async () => {
    withDb({
      user_entitlements: [
        { user_id: USER, entitlement_group_id: GROUP, revoked_at: null },
      ],
    });
    db.failWrites("audit_log");
    expect(
      await revokeEntitlement({
        userId: USER,
        entitlementGroupId: GROUP,
        revokedBy: ADMIN,
      })
    ).toEqual({ success: false, error: "audit unavailable" });
    expect(db.rows("user_entitlements")[0].revoked_at).toBeNull();
    db.failing.delete("audit_log");
    db.failWrites("user_entitlements");
    expect(
      (
        await revokeEntitlement({
          userId: USER,
          entitlementGroupId: GROUP,
          revokedBy: ADMIN,
        })
      ).success
    ).toBe(false);
  });

  it("lists only live grants of active groups (expired, revoked and inactive grant nothing)", async () => {
    withDb({
      user_entitlements: [
        {
          user_id: USER,
          entitlement_group_id: "g-live",
          revoked_at: null,
          expires_at: future,
        },
        {
          user_id: USER,
          entitlement_group_id: "g-forever",
          revoked_at: null,
          expires_at: null,
        },
        {
          user_id: USER,
          entitlement_group_id: "g-expired",
          revoked_at: null,
          expires_at: past,
        },
        {
          user_id: USER,
          entitlement_group_id: "g-revoked",
          revoked_at: past,
          expires_at: null,
        },
        {
          user_id: USER,
          entitlement_group_id: "g-off",
          revoked_at: null,
          expires_at: null,
        },
        { user_id: "someone-else", entitlement_group_id: "g-live", revoked_at: null },
      ],
      entitlement_groups: [
        { id: "g-live", code: "live", is_active: true },
        { id: "g-forever", code: "forever", is_active: true },
        { id: "g-expired", code: "expired", is_active: true },
        { id: "g-revoked", code: "revoked", is_active: true },
        { id: "g-off", code: "off", is_active: false },
      ],
    });
    const codes = (await getUserEntitlements(USER)).map((e) => e.code).sort();
    expect(codes).toEqual(["forever", "live"]);
  });

  it("lists nothing when the read fails (fail closed)", async () => {
    (getSupabaseServiceClient as jest.Mock).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({ is: async () => ({ data: null, error: { message: "down" } }) }),
        }),
      }),
    });
    expect(await getUserEntitlements(USER)).toEqual([]);
  });
});

describe("consent", () => {
  it("grants and revokes, each recorded before it is written", async () => {
    withDb({ consent_records: [] });
    expect(
      await grantConsent({ userId: USER, consentType: "terms", consentVersion: "1" })
    ).toEqual({ success: true });
    expect(await hasConsent(USER, "terms")).toBe(true);
    expect(await revokeConsent({ userId: USER, consentType: "terms" })).toEqual({
      success: true,
    });
    expect(await hasConsent(USER, "terms")).toBe(false);
    expect(db.rows("audit_log").map((r) => r.action)).toEqual([
      "consent_granted",
      "consent_revoked",
    ]);
  });

  it("records nothing and changes nothing when the audit log is unavailable", async () => {
    withDb({ consent_records: [] });
    db.failWrites("audit_log");
    expect(
      await grantConsent({ userId: USER, consentType: "terms", consentVersion: "1" })
    ).toEqual({ success: false, error: "audit unavailable" });
    expect(await revokeConsent({ userId: USER, consentType: "terms" })).toEqual({
      success: false,
      error: "audit unavailable",
    });
    expect(db.rows("consent_records")).toHaveLength(0);
  });

  it("reports a failed write", async () => {
    withDb({ consent_records: [] });
    db.failWrites("consent_records");
    expect(
      (await grantConsent({ userId: USER, consentType: "terms", consentVersion: "1" }))
        .success
    ).toBe(false);
    expect((await revokeConsent({ userId: USER, consentType: "terms" })).success).toBe(
      false
    );
  });

  it("answers no consent when consent cannot be read (fail closed)", async () => {
    (getSupabaseServiceClient as jest.Mock).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => ({
              order: async () => ({ data: null, error: { message: "down" } }),
            }),
          }),
        }),
      }),
    });
    expect(await getUserConsents(USER)).toEqual([]);
    expect(await hasConsent(USER, "terms")).toBe(false);
  });

  it("does not count another user's consent, or a revoked one", async () => {
    withDb({
      consent_records: [
        { user_id: "other", consent_type: "terms", revoked_at: null, granted_at: "1" },
        {
          user_id: USER,
          consent_type: "terms",
          revoked_at: "2026-01-01",
          granted_at: "1",
        },
      ],
    });
    expect(await hasConsent(USER, "terms")).toBe(false);
  });
});

describe("GDPR deletion", () => {
  const mod = (name: string, ok = true): DeletionModule => ({
    moduleName: name,
    description: name,
    tables: [name],
    softDelete: jest.fn(async () => (ok ? { success: true } : { success: false })),
    hardPurge: jest.fn(async () =>
      ok ? { success: true } : { success: false, error: "x" }
    ),
  });

  const seed = () =>
    withDb({
      users: [{ id: USER, email: "a@b.c", display_name: "A", deleted_at: null }],
      deletion_manifest: [],
    });

  it("replaces a module registered twice under one name", () => {
    registerDeletionModule(mod("dup"));
    registerDeletionModule(mod("dup"));
    expect(getDeletionModules().filter((m) => m.moduleName === "dup")).toHaveLength(1);
  });

  it("soft-deletes: records first, anonymises, runs every module, writes the manifest", async () => {
    seed();
    registerDeletionModule(mod("ok-module"));
    const res = await softDeleteUser(USER, ADMIN);
    expect(res).toEqual({ success: true, errors: [] });
    expect(db.writes[0]).toEqual(expect.arrayContaining(["insert", "audit_log"]));
    expect(db.rows("users")[0]).toMatchObject({ email: null, display_name: "[deleted]" });
    expect(db.rows("deletion_manifest")[0]).toMatchObject({ status: "completed" });
  });

  it("reports a partial deletion as a failure", async () => {
    seed();
    registerDeletionModule(mod("failing-module", false));
    const res = await softDeleteUser(USER, ADMIN);
    expect(res.success).toBe(false);
    expect(res.errors).toContain("failing-module: Unknown error");
    expect(db.rows("deletion_manifest")[0]).toMatchObject({ status: "partial" });
    registerDeletionModule(mod("failing-module")); // leave the registry passing
  });

  it("reports failure when the manifest cannot be written", async () => {
    seed();
    db.failWrites("deletion_manifest");
    const res = await softDeleteUser(USER, ADMIN);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.startsWith("deletion manifest"))).toBe(true);
  });

  it("deletes nothing when the audit log is unavailable", async () => {
    seed();
    db.failWrites("audit_log");
    expect(await softDeleteUser(USER, ADMIN)).toEqual({
      success: false,
      errors: ["audit unavailable"],
    });
    expect(db.rows("users")[0].email).toBe("a@b.c");
  });

  it("hard purge reports every failure (module, user row)", async () => {
    seed();
    registerDeletionModule(mod("purge-fails", false));
    db.failWrites("users");
    const res = await hardPurgeUser(USER);
    expect(res.success).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining(["purge-fails: x", expect.stringMatching(/^users:/)])
    );
    registerDeletionModule(mod("purge-fails"));
  });

  it("hard purge removes the user row when every step succeeds", async () => {
    seed();
    const res = await hardPurgeUser(USER);
    expect(res).toEqual({ success: true, errors: [] });
    expect(db.rows("users")).toHaveLength(0);
  });
});
