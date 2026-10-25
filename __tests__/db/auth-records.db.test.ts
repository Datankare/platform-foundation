/**
 * @jest-environment node
 */
/**
 * The user's records against the replayed database, in the request's tenant (ADR-053 D4):
 * consent, devices, entitlement assignments, password policy, GDPR export and deletion. Every
 * SQL path — success, nothing matched, conflict, refusal — each change recorded before it takes
 * effect, and the records isolated between tenants (D8).
 *
 * The entitlement catalog (entitlement_groups) is platform-owned and empty in the replayed
 * database, and test suites never write platform tables: a grant here can only exercise the
 * refusal (the foreign key to the catalog), not a successful grant.
 */

jest.mock("@/platform/data", () => jest.requireActual("../helpers/data-spy").spiedData());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { auditRowsForUser } from "@/platform/auth/audit";
import {
  getUserConsents,
  grantConsent,
  hasConsent,
  revokeConsent,
} from "@/platform/auth/consent";
import { listUserDevices, registerDevice, removeDevice } from "@/platform/auth/devices";
import {
  getUserEntitlements,
  grantEntitlement,
  revokeEntitlement,
} from "@/platform/auth/entitlements";
import {
  estimateExportSize,
  exportUserData,
  registerExportModule,
} from "@/platform/auth/data-export";
import {
  hardPurgeUser,
  registerDeletionModule,
  softDeleteUser,
  type DeletionModule,
} from "@/platform/auth/gdpr-deletion";
import {
  DEFAULT_POLICY,
  getEffectivePasswordPolicy,
  getGlobalPasswordPolicy,
  saveGlobalPasswordPolicy,
} from "@/platform/auth/password-policy";
import { withTenantTx } from "@/platform/data";
import { runWithoutTenant } from "@/platform/tenancy/context";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { catalogName, createCatalog, dropCatalog, newRun } from "../helpers/db-admin";
import { dataSpy, resetDataSpy, uuid } from "../helpers/data-spy";
import {
  DB_ENABLED,
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

type Row = Record<string, unknown>;

async function sql(t: TestTenant, text: string, values: unknown[] = []): Promise<Row[]> {
  return t.run(() => withTenantTx(async (tx) => (await tx.query(text, values)).rows));
}

const auditOf = (t: TestTenant, id: string) =>
  t.run(() => withTenantTx((tx) => auditRowsForUser(tx, id, 50)));

const SUITE = "auth: user records (Postgres)";
let t: TestTenant;
let user: string;

// Once per file, as before; nothing connects when the database is absent.
if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
    user = await t.user();
    resetDataSpy();
  });
}

// ── Consent ─────────────────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} consent`, () => {
  it("grants (recorded first) and lists active consents, newest first", async () => {
    await expect(
      t.run(() =>
        grantConsent({
          userId: user,
          consentType: "analytics",
          consentVersion: "1",
          ipAddress: "192.0.2.1",
          userAgent: "jest",
        })
      )
    ).resolves.toEqual({ success: true });
    expect(dataSpy().writes).toEqual([
      ["insert", "audit_log"],
      ["insert", "consent_records"],
    ]);
    await t.run(() =>
      grantConsent({ userId: user, consentType: "marketing", consentVersion: "2" })
    );
    const list = await t.run(() => getUserConsents(user));
    expect(list.map((c) => c.consentType)).toEqual(["marketing", "analytics"]);
    expect(list[1]).toMatchObject({
      userId: user,
      consentVersion: "1",
      granted: true,
      revokedAt: null,
    });
    expect(list[1].grantedAt).toMatch(/Z$/);
    await expect(t.run(() => hasConsent(user, "analytics"))).resolves.toBe(true);
    await expect(t.run(() => hasConsent(user, "other"))).resolves.toBe(false);
  });

  it("revokes by marking (the record stays), recorded first", async () => {
    await t.run(() =>
      grantConsent({ userId: user, consentType: "analytics", consentVersion: "1" })
    );
    resetDataSpy();
    await expect(
      t.run(() => revokeConsent({ userId: user, consentType: "analytics" }))
    ).resolves.toEqual({ success: true });
    expect(dataSpy().writes).toEqual([
      ["insert", "audit_log"],
      ["update", "consent_records"],
    ]);
    await expect(t.run(() => hasConsent(user, "analytics"))).resolves.toBe(false);
    const [row] = await sql(
      t,
      "select revoked_at from consent_records where user_id = $1::uuid",
      [user]
    );
    expect(row.revoked_at).toBeInstanceOf(Date);
    // Revoking what is not held matches nothing and is not an error.
    await expect(
      t.run(() => revokeConsent({ userId: user, consentType: "never-held" }))
    ).resolves.toEqual({ success: true });
  });

  it("reports a refused write (no such user) with a failed follow-up record", async () => {
    const ghost = uuid();
    const out = await t.run(() =>
      grantConsent({ userId: ghost, consentType: "analytics", consentVersion: "1" })
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/foreign key/);
    const outcomes = (await auditOf(t, ghost)).map((r) => (r.details as Row).outcome);
    expect(outcomes.sort()).toEqual(["attempted", "failed"]);
    const bad = await t.run(() => revokeConsent({ userId: "x", consentType: "a" }));
    expect(bad.success).toBe(false);
  });

  it("changes nothing when the audit log is unavailable", async () => {
    dataSpy().auditDown = true;
    await expect(
      t.run(() => grantConsent({ userId: user, consentType: "a", consentVersion: "1" }))
    ).resolves.toEqual({ success: false, error: "audit unavailable" });
    await expect(
      t.run(() => revokeConsent({ userId: user, consentType: "a" }))
    ).resolves.toEqual({ success: false, error: "audit unavailable" });
    expect(dataSpy().writes).toEqual([]);
  });

  it("answers no consent when consent cannot be read (fail closed)", async () => {
    await runWithoutTenant(async () => {
      await expect(getUserConsents(user)).resolves.toEqual([]);
      await expect(hasConsent(user, "analytics")).resolves.toBe(false);
    });
  });
});

dbDescribe(SUITE, () => {
  runTenantIsolationContract({
    name: "consent records",
    makeStore: () => null,
    // Each kit tenant has its own user (currentUser reads it inside the tenant).
    createTenant: async () => {
      const tenant = await createTestTenant();
      await tenant.user();
      return tenant;
    },
    write: async (_s, key) => {
      const out = await grantConsent({
        userId: await currentUser(),
        consentType: key,
        consentVersion: "1",
      });
      if (!out.success) throw new Error(out.error);
    },
    read: async (_s, key) => {
      const list = await getUserConsents(await currentUser());
      return list.find((c) => c.consentType === key) ?? null;
    },
    remove: async (_s, key) => {
      await revokeConsent({ userId: await currentUser(), consentType: key });
    },
    failsClosedWithoutTenant: false,
  });
});

// ── Devices ─────────────────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} devices`, () => {
  it("registers a new device (recorded first) and lists by last use", async () => {
    await expect(t.run(() => registerDevice(user, "dev-1", "Phone"))).resolves.toEqual({
      success: true,
    });
    expect(dataSpy().writes).toEqual([
      ["insert", "audit_log"],
      ["insert", "user_devices"],
    ]);
    await t.run(() => registerDevice(user, "dev-2"));
    const list = await t.run(() => listUserDevices(user));
    expect(list.map((d) => d.deviceId)).toEqual(["dev-2", "dev-1"]);
    expect(list[1]).toMatchObject({
      userId: user,
      deviceName: "Phone",
      isTrusted: false,
    });
    expect(list[1].lastUsedAt).toMatch(/Z$/);
    expect(list[1].createdAt).toMatch(/Z$/);
  });

  it("refreshes a known device without a new record, even with the audit log down", async () => {
    await t.run(() => registerDevice(user, "dev-1", "Phone"));
    const [before] = await sql(t, "select last_used_at from user_devices");
    resetDataSpy();
    dataSpy().auditDown = true;
    await expect(t.run(() => registerDevice(user, "dev-1", "Phone"))).resolves.toEqual({
      success: true,
    });
    expect(dataSpy().writes).toEqual([["update", "user_devices"]]);
    const [after] = await sql(t, "select last_used_at from user_devices");
    expect((after.last_used_at as Date) >= (before.last_used_at as Date)).toBe(true);
    expect(await sql(t, "select id from user_devices")).toHaveLength(1);
  });

  it("removes a device (recorded first); removing an unknown one matches nothing", async () => {
    await t.run(() => registerDevice(user, "dev-1"));
    resetDataSpy();
    await expect(t.run(() => removeDevice(user, "dev-1"))).resolves.toEqual({
      success: true,
    });
    expect(dataSpy().writes).toEqual([
      ["insert", "audit_log"],
      ["delete", "user_devices"],
    ]);
    await expect(t.run(() => listUserDevices(user))).resolves.toEqual([]);
    await expect(t.run(() => removeDevice(user, "dev-none"))).resolves.toEqual({
      success: true,
    });
  });

  it("reports a refused write: a device for no such user, a malformed id", async () => {
    const out = await t.run(() => registerDevice(uuid(), "dev-1"));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/foreign key/);
    // A malformed id is refused by the audit record itself (not a user id).
    await expect(t.run(() => removeDevice("x", "dev-1"))).resolves.toEqual({
      success: false,
      error: "audit unavailable",
    });
  });

  it("changes nothing when the audit log is unavailable", async () => {
    await t.run(() => registerDevice(user, "dev-1"));
    resetDataSpy();
    dataSpy().auditDown = true;
    await expect(t.run(() => registerDevice(user, "dev-2"))).resolves.toEqual({
      success: false,
      error: "audit unavailable",
    });
    await expect(t.run(() => removeDevice(user, "dev-1"))).resolves.toEqual({
      success: false,
      error: "audit unavailable",
    });
    expect(dataSpy().writes).toEqual([]);
  });

  it("lists nothing when the store cannot be read", async () => {
    await runWithoutTenant(async () => {
      await expect(listUserDevices(user)).resolves.toEqual([]);
    });
  });
});

dbDescribe(SUITE, () => {
  runTenantIsolationContract({
    name: "devices",
    makeStore: () => null,
    createTenant: async () => {
      const tenant = await createTestTenant();
      await tenant.user();
      return tenant;
    },
    write: async (_s, key) => {
      const out = await registerDevice(await currentUser(), key, "kit");
      if (!out.success) throw new Error(out.error);
    },
    read: async (_s, key) => {
      const list = await listUserDevices(await currentUser());
      return list.find((d) => d.deviceId === key) ?? null;
    },
    remove: async (_s, key) => {
      await removeDevice(await currentUser(), key);
    },
    failsClosedWithoutTenant: false,
  });
});

// ── Entitlement assignments ─────────────────────────────────────────────────────────────

/** A verified admin holding `permissions` (the rules are applied to what they hold). */
const asAdmin = (
  userId: string,
  permissions: string[] = ["admin_manage_entitlements"]
) => ({
  userId,
  sub: `sub-${userId}`,
  roleName: "admin",
  permissions,
});

dbDescribe(`${SUITE} entitlements`, () => {
  it("lists no entitlements for a user with none", async () => {
    await expect(t.run(() => getUserEntitlements(user))).resolves.toEqual([]);
  });

  it("a grant of a group the catalog does not hold is refused, with a failed follow-up record", async () => {
    const admin = asAdmin(await t.user("admin"));
    const out = await t.run(() =>
      grantEntitlement({
        userId: user,
        entitlementGroupId: uuid(),
        grantedBy: admin,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/foreign key/);
    const outcomes = (await auditOf(t, user)).map((r) => (r.details as Row).outcome);
    expect(outcomes.sort()).toEqual(["attempted", "failed"]);
    expect(await sql(t, "select id from user_entitlements")).toEqual([]);
  });

  it("revokes by marking; a revoke that matches nothing succeeds, recorded first", async () => {
    const admin = asAdmin(await t.user("admin"));
    await expect(
      t.run(() =>
        revokeEntitlement({
          userId: user,
          entitlementGroupId: uuid(),
          revokedBy: admin,
        })
      )
    ).resolves.toEqual({ success: true });
    expect(dataSpy().writes).toEqual([["insert", "audit_log"]]);
    const bad = await t.run(() =>
      revokeEntitlement({
        userId: user,
        entitlementGroupId: "not-a-uuid",
        revokedBy: admin,
      })
    );
    expect(bad.success).toBe(false);
  });

  it("changes nothing when the audit log is unavailable", async () => {
    const admin = asAdmin(await t.user("admin"));
    dataSpy().auditDown = true;
    await expect(
      t.run(() =>
        grantEntitlement({ userId: user, entitlementGroupId: uuid(), grantedBy: admin })
      )
    ).resolves.toEqual({ success: false, error: "audit unavailable" });
    await expect(
      t.run(() =>
        revokeEntitlement({
          userId: user,
          entitlementGroupId: uuid(),
          revokedBy: admin,
        })
      )
    ).resolves.toEqual({ success: false, error: "audit unavailable" });
    expect(dataSpy().writes).toEqual([]);
  });

  it("lists nothing when the store cannot be read", async () => {
    await runWithoutTenant(async () => {
      await expect(getUserEntitlements(user)).resolves.toEqual([]);
    });
  });

  // ── Release review RR-17: the grant rules are the function's own ──

  describe("the role rules", () => {
    const RUN = newRun();
    let groups: Record<string, string>;
    beforeAll(async () => {
      const cat = await createCatalog(RUN, {
        permissions: ["perk"],
        roles: {},
        groups: {
          plain: { permissions: ["perk"] },
          mighty: { permissions: ["admin_manage_roles"] },
        },
      });
      groups = cat.groups;
    });
    afterAll(dropCatalog);

    it("grants a group whose permissions the admin holds", async () => {
      const admin = asAdmin(await t.user("admin"), [catalogName(RUN, "perk")]);
      await expect(
        t.run(() =>
          grantEntitlement({
            userId: user,
            entitlementGroupId: groups.plain,
            grantedBy: admin,
          })
        )
      ).resolves.toEqual({ success: true });
      await expect(
        t.run(() =>
          revokeEntitlement({
            userId: user,
            entitlementGroupId: groups.plain,
            revokedBy: admin,
          })
        )
      ).resolves.toEqual({ success: true });
    });

    it("refuses a group carrying a permission the admin does not hold — granting or revoking", async () => {
      const admin = asAdmin(await t.user("admin"), [catalogName(RUN, "perk")]);
      const granted = await t.run(() =>
        grantEntitlement({
          userId: user,
          entitlementGroupId: groups.mighty,
          grantedBy: admin,
        })
      );
      expect(granted).toMatchObject({ success: false, error: "auth.grant_exceeds_own" });
      const revoked = await t.run(() =>
        revokeEntitlement({
          userId: user,
          entitlementGroupId: groups.mighty,
          revokedBy: admin,
        })
      );
      expect(revoked).toMatchObject({ success: false, error: "auth.grant_exceeds_own" });
      expect(await sql(t, "select id from user_entitlements")).toEqual([]);
    });

    it("refuses an admin changing their own entitlements", async () => {
      const id = await t.user("self");
      const admin = asAdmin(id, [catalogName(RUN, "perk")]);
      const out = await t.run(() =>
        grantEntitlement({
          userId: id,
          entitlementGroupId: groups.plain,
          grantedBy: admin,
        })
      );
      expect(out).toMatchObject({ success: false, error: "auth.role_self_change" });
    });
  });
});

// ── Password policy ─────────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} password policy`, () => {
  it("a new tenant has no policy: the defaults apply", async () => {
    await expect(t.run(() => getGlobalPasswordPolicy())).resolves.toEqual(DEFAULT_POLICY);
    await expect(t.run(() => getEffectivePasswordPolicy(user, uuid()))).resolves.toEqual(
      DEFAULT_POLICY
    );
  });

  it("saves the tenant's global policy (insert, then update in place) and keeps zeros", async () => {
    const policy = { ...DEFAULT_POLICY, minLength: 10, rotationDays: 0 };
    await expect(t.run(() => saveGlobalPasswordPolicy(policy))).resolves.toEqual({
      success: true,
    });
    await expect(t.run(() => getGlobalPasswordPolicy())).resolves.toEqual(policy);
    const next = { ...policy, passwordHistoryCount: 0, requireSpecial: false };
    await t.run(() => saveGlobalPasswordPolicy(next));
    await expect(t.run(() => getGlobalPasswordPolicy())).resolves.toEqual(next);
    expect(await sql(t, "select id from password_policy")).toHaveLength(1);
  });

  it("two saves at once leave one global row", async () => {
    await Promise.all([
      t.run(() => saveGlobalPasswordPolicy({ ...DEFAULT_POLICY, minLength: 14 })),
      t.run(() => saveGlobalPasswordPolicy({ ...DEFAULT_POLICY, minLength: 16 })),
    ]);
    expect(await sql(t, "select id from password_policy")).toHaveLength(1);
  });

  it("resolves individual → role → global", async () => {
    const [{ id: roleId }] = await sql(
      t,
      "select role_id as id from users where id = $1::uuid",
      [user]
    );
    await t.run(() => saveGlobalPasswordPolicy({ ...DEFAULT_POLICY, minLength: 9 }));
    await expect(
      t.run(() => getEffectivePasswordPolicy(user, String(roleId)))
    ).resolves.toMatchObject({ minLength: 9 });
    await sql(
      t,
      "insert into password_policy (role_id, min_length) values ($1::uuid, 11)",
      [roleId]
    );
    await expect(
      t.run(() => getEffectivePasswordPolicy(user, String(roleId)))
    ).resolves.toMatchObject({ minLength: 11 });
    await sql(
      t,
      "insert into password_policy (user_id, min_length) values ($1::uuid, 13)",
      [user]
    );
    await expect(
      t.run(() => getEffectivePasswordPolicy(user, String(roleId)))
    ).resolves.toMatchObject({ minLength: 13 });
    // A malformed id matches nothing; the global row still applies.
    await expect(
      t.run(() => getEffectivePasswordPolicy("x", "y"))
    ).resolves.toMatchObject({
      minLength: 9,
    });
  });

  it("is the tenant's own: another tenant still has the defaults", async () => {
    await t.run(() => saveGlobalPasswordPolicy({ ...DEFAULT_POLICY, minLength: 20 }));
    const other = await createTestTenant();
    await expect(other.run(() => getGlobalPasswordPolicy())).resolves.toEqual(
      DEFAULT_POLICY
    );
  });

  it("an unreadable store gives the defaults; a save reports failure", async () => {
    await runWithoutTenant(async () => {
      await expect(getGlobalPasswordPolicy()).resolves.toEqual(DEFAULT_POLICY);
      await expect(getEffectivePasswordPolicy(user, "r")).resolves.toEqual(
        DEFAULT_POLICY
      );
      const saved = await saveGlobalPasswordPolicy(DEFAULT_POLICY);
      expect(saved.success).toBe(false);
    });
    const bad = await t.run(() =>
      saveGlobalPasswordPolicy({ ...DEFAULT_POLICY, minLength: "x" as never })
    );
    expect(bad.success).toBe(false);
  });
});

// ── GDPR export ─────────────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} data export`, () => {
  it("records the export first and returns the user's rows, in their JSON form", async () => {
    await t.run(async () => {
      await grantConsent({
        userId: user,
        consentType: "analytics",
        consentVersion: "1",
      });
      await registerDevice(user, "dev-1");
    });
    resetDataSpy();
    const { data, errors } = await t.run(() => exportUserData(user));
    expect(errors).toEqual([]);
    expect(dataSpy().writes).toEqual([["insert", "audit_log"]]);
    expect(data.profile).toMatchObject({ id: user, tenant_id: t.id });
    expect(typeof (data.profile as Row).created_at).toBe("string");
    expect(data.consents).toHaveLength(1);
    expect(data.devices).toEqual([expect.objectContaining({ device_id: "dev-1" })]);
    expect(data.entitlements).toEqual([]);
    const actions = (data.auditLog as Row[]).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["consent_granted", "device_registered"])
    );
    expect(data._meta).toMatchObject({ userId: user, format: "JSON" });
  });

  it("includes registered modules; a failing one withholds the whole export (RR-23)", async () => {
    registerExportModule({
      moduleName: "db-test-module",
      description: "x",
      collectData: async () => ({ data: { ok: true } }),
    });
    const whole = await t.run(() => exportUserData(user));
    expect(whole.data["db-test-module"]).toEqual({ ok: true });
    registerExportModule({
      moduleName: "db-test-failing",
      description: "x",
      collectData: async () => ({ data: {}, error: "nope" }),
    });
    const { data, errors } = await t.run(() => exportUserData(user));
    expect(data).toEqual({});
    expect(errors).toEqual(["db-test-failing: nope"]);
    registerExportModule({
      moduleName: "db-test-failing",
      description: "x",
      collectData: async () => ({ data: {} }),
    });
  });

  it("reports a user with no live row", async () => {
    await sql(t, "update users set deleted_at = now() where id = $1::uuid", [user]);
    const { data, errors } = await t.run(() => exportUserData(user));
    expect(errors).toContain("users: no live user row");
    expect(data).toEqual({});
  });

  it("returns no data when the export cannot be recorded; estimates without recording", async () => {
    dataSpy().auditDown = true;
    await expect(t.run(() => exportUserData(user))).resolves.toEqual({
      data: {},
      errors: ["audit unavailable"],
    });
    dataSpy().auditDown = false;
    resetDataSpy();
    const { estimatedBytes } = await t.run(() => estimateExportSize(user));
    expect(estimatedBytes).toBeGreaterThan(0);
    expect(dataSpy().writes).toEqual([]);
  });

  it.each(["not-a-uuid", "x,target_id.neq.null", ""])(
    "refuses to export for the crafted id %p",
    async (id) => {
      await expect(t.run(() => exportUserData(id))).resolves.toEqual({
        data: {},
        errors: ["invalid user id"],
      });
      expect(dataSpy().writes).toEqual([]);
    }
  );

  it("never includes another tenant's rows, and reports an unreadable store", async () => {
    const other = await createTestTenant();
    const { data, errors } = await other.run(() => exportUserData(user));
    expect(data).toEqual({});
    expect(errors).toContain("users: no live user row");
    await runWithoutTenant(async () => {
      const out = await exportUserData(user);
      expect(out.data).toEqual({});
      expect(out.errors).toEqual([expect.stringMatching(/^store: No tenant context/)]);
    });
  });
});

// ── GDPR deletion ───────────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} deletion`, () => {
  const mod = (name: string, ok = true): DeletionModule => ({
    moduleName: name,
    description: name,
    tables: [name],
    softDelete: jest.fn(async () => (ok ? { success: true } : { success: false })),
    hardPurge: jest.fn(async () =>
      ok ? { success: true } : { success: false, error: "x" }
    ),
  });

  it("soft delete: recorded first, anonymises, runs every module, records the erasure", async () => {
    const admin = await t.user("admin");
    registerDeletionModule(mod("db-ok-module"));
    resetDataSpy();
    const res = await t.run(() => softDeleteUser(user, admin));
    expect(dataSpy().writes.slice(0, 2)).toEqual([
      ["insert", "audit_log"],
      ["update", "users"],
    ]);
    // The erasure is recorded in user_deletions, with its purge time and the modules involved.
    expect(res).toEqual({ success: true, errors: [] });
    const [record] = await sql(
      t,
      "select * from user_deletions where user_id = $1::uuid",
      [user]
    );
    expect(record).toMatchObject({ requested_by: admin, purged_at: null });
    expect(record.modules).toContain("db-ok-module");
    expect((record.purge_after as Date).getTime()).toBeGreaterThan(
      Date.now() + 29 * 86_400_000
    );
    const [row] = await sql(t, "select * from users where id = $1::uuid", [user]);
    expect(row).toMatchObject({
      email: null,
      display_name: "[deleted]",
      real_name: null,
      avatar_url: null,
      date_of_birth: null,
    });
    expect(row.deleted_at).toBeInstanceOf(Date);
    const outcomes = (await auditOf(t, user)).map((r) => (r.details as Row).outcome);
    expect(outcomes).toEqual(["attempted"]); // a success needs no follow-up record
  });

  it("reports a failing module", async () => {
    registerDeletionModule(mod("db-failing-module", false));
    const res = await t.run(() => softDeleteUser(user, user));
    expect(res.errors).toContain("db-failing-module: Unknown error");
    registerDeletionModule(mod("db-failing-module"));
  });

  it("reports a refused anonymisation", async () => {
    const res = await runWithoutTenant(() => softDeleteUser(user, user));
    expect(res).toEqual({ success: false, errors: ["audit unavailable"] });
    const missing = await t.run(() => softDeleteUser(uuid(), user));
    expect(missing).toEqual({ success: false, errors: ["users: no such user"] });
  });

  it("deletes nothing when the audit log is unavailable", async () => {
    dataSpy().auditDown = true;
    await expect(t.run(() => softDeleteUser(user, user))).resolves.toEqual({
      success: false,
      errors: ["audit unavailable"],
    });
    const [row] = await sql(t, "select deleted_at from users where id = $1::uuid", [
      user,
    ]);
    expect(row.deleted_at).toBeNull();
  });

  it("hard purge removes the user row (and its children) when every step succeeds", async () => {
    await t.run(() => registerDevice(user, "dev-1"));
    await expect(t.run(() => hardPurgeUser(user))).resolves.toMatchObject({
      success: true,
      errors: [],
    });
    expect(await sql(t, "select id from users where id = $1::uuid", [user])).toEqual([]);
    expect(await sql(t, "select id from user_devices")).toEqual([]);
  });

  it("hard purge reports every failure (module, user row)", async () => {
    registerDeletionModule(mod("db-purge-fails", false));
    const res = await runWithoutTenant(() => hardPurgeUser(user));
    expect(res.success).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining(["db-purge-fails: x", expect.stringMatching(/^users:/)])
    );
    registerDeletionModule(mod("db-purge-fails"));
  });

  it("another tenant cannot delete or purge this tenant's user", async () => {
    const other = await createTestTenant();
    await other.run(() => softDeleteUser(user, user));
    await other.run(() => hardPurgeUser(user));
    const [row] = await sql(t, "select deleted_at from users where id = $1::uuid", [
      user,
    ]);
    expect(row).toEqual({ deleted_at: null });
  });
});

/** The first user of the current tenant (the kit's tenants each create one). */
async function currentUser(): Promise<string> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ id: string }>("select id from users order by created_at, id limit 1")
  );
  if (!rows[0]) throw new Error("the tenant has no user");
  return rows[0].id;
}
