/**
 * @jest-environment node
 */
/**
 * The user row against the replayed database, in the request's tenant (ADR-053 D4):
 * provisioning (TASK-117), the account-status guard, the COPPA gate and COPPA records, profiles,
 * and permission resolution — every SQL path, the fail-closed ones included, and the row
 * isolated between tenants (D8).
 */

jest.mock("@/platform/data", () => jest.requireActual("../helpers/data-spy").spiedData());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Governed lists come from platform-config (another module's SQL): the defaults apply here.
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (_key: string, fallback: unknown) => fallback),
}));

import {
  checkAccountStatus,
  isInGoodStanding,
} from "@/platform/auth/account-status-guard";
import { auditRowsForUser } from "@/platform/auth/audit";
import {
  checkCoppaGate,
  consentFeatureFallback,
  updateCoppaEnforcement,
} from "@/platform/auth/coppa-gate";
import { recordAgeVerification, recordParentalConsent } from "@/platform/auth/coppa";
import {
  getOwnProfile,
  getProfileAsAdmin,
  getPublicProfile,
  updateProfile,
} from "@/platform/auth/profile";
import { hasPermission, resolvePermissions } from "@/platform/auth/permissions";
import { ensureUserProvisioned } from "@/platform/auth/user-provisioning";
import { AuditWriteError } from "@/platform/auth/audit";
import { withTenantTx } from "@/platform/data";
import { TenantContextError, runWithoutTenant } from "@/platform/tenancy/context";
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

/** Run SQL in tenant `t` (fixtures and checks; the code under test runs its own). */
async function sql(t: TestTenant, text: string, values: unknown[] = []): Promise<Row[]> {
  return t.run(() => withTenantTx(async (tx) => (await tx.query(text, values)).rows));
}

const userRow = async (t: TestTenant, id: string): Promise<Row | undefined> =>
  (await sql(t, "select * from users where id = $1::uuid", [id]))[0];

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

const SUITE = "auth: the user row (Postgres)";
let t: TestTenant;

// Once per file, as before; nothing connects when the database is absent.
if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    resetDataSpy();
    t = await createTestTenant();
  });
}

// ── Provisioning (TASK-117) ─────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} ensureUserProvisioned`, () => {
  it("creates the row with the default role in the current tenant, audited first", async () => {
    const sub = uuid();
    const out = await t.run(() =>
      ensureUserProvisioned(sub, {
        email: " Raman@Datankare.com ",
        emailVerified: true,
      })
    );
    expect(out).toBe("created");
    expect(dataSpy().writes).toEqual([
      ["insert", "audit_log"],
      ["insert", "users"],
    ]);
    const row = await userRow(t, sub);
    expect(row).toMatchObject({
      id: sub,
      cognito_sub: sub,
      email: "raman@datankare.com",
      email_verified: true,
      tenant_id: t.id,
      account_status: "active",
    });
    const [role] = await sql(t, "select name from roles where id = $1", [row!.role_id]);
    expect(role.name).toBe("free");
    const audit = await t.run(() => withTenantTx((tx) => auditRowsForUser(tx, sub, 10)));
    expect(audit[0]).toMatchObject({ action: "account_created", target_id: sub });
  });

  it("leaves an existing row untouched and records nothing", async () => {
    const id = await t.user("existing");
    await sql(t, "update users set account_status = 'banned' where id = $1::uuid", [id]);
    resetDataSpy();
    await expect(t.run(() => ensureUserProvisioned(id))).resolves.toBe("existing");
    expect(dataSpy().writes).toEqual([]);
    expect((await userRow(t, id))!.account_status).toBe("banned");
  });

  it("two first requests at once create one row", async () => {
    const sub = uuid();
    const outs = await Promise.all([
      t.run(() => ensureUserProvisioned(sub)),
      t.run(() => ensureUserProvisioned(sub)),
    ]);
    expect(outs.filter((o) => o === "created")).toHaveLength(1);
    expect(outs.every((o) => o === "created" || o === "existing")).toBe(true);
    expect(await sql(t, "select id from users where id = $1::uuid", [sub])).toHaveLength(
      1
    );
  });

  it("stores no email when the token has none", async () => {
    const sub = uuid();
    await t.run(() => ensureUserProvisioned(sub, { email: "  " }));
    expect(await userRow(t, sub)).toMatchObject({ email: null, email_verified: false });
  });

  it("creates no row, and reports failure, when the audit record cannot be written", async () => {
    dataSpy().auditDown = true;
    const sub = uuid();
    await expect(t.run(() => ensureUserProvisioned(sub))).resolves.toBe("failed");
    expect(await userRow(t, sub)).toBeUndefined();
  });

  it("records the failed outcome when the insert fails after the attempt", async () => {
    // cognito_sub is unique: a second subject whose cognito_sub is already taken fails.
    const sub = uuid();
    const taken = await t.user("taken");
    await sql(t, "update users set cognito_sub = $2 where id = $1::uuid", [taken, sub]);
    await expect(t.run(() => ensureUserProvisioned(sub))).resolves.toBe("failed");
    const audit = await t.run(() => withTenantTx((tx) => auditRowsForUser(tx, sub, 10)));
    expect(audit.map((r) => (r.details as Row).outcome).sort()).toEqual([
      "attempted",
      "failed",
    ]);
  });

  it("refuses a subject that is not a UUID, without a query", async () => {
    await expect(t.run(() => ensureUserProvisioned("not-a-sub"))).resolves.toBe("failed");
    expect(dataSpy().writes).toEqual([]);
  });

  it("fails (never allows) outside a tenant", async () => {
    await runWithoutTenant(async () => {
      await expect(ensureUserProvisioned(uuid())).resolves.toBe("failed");
    });
  });
});

// ── Account-status guard ────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} checkAccountStatus / isInGoodStanding`, () => {
  const setStatus = (id: string, status: string, cols: Row = {}) =>
    sql(
      t,
      `update users set account_status = $2::account_status,
            restricted_until = $3::timestamptz, suspended_until = $4::timestamptz,
            banned_at = $5::timestamptz
          where id = $1::uuid`,
      [
        id,
        status,
        cols.restricted_until ?? null,
        cols.suspended_until ?? null,
        cols.banned_at ?? null,
      ]
    );

  it("allows an active user", async () => {
    const id = await t.user();
    await expect(t.run(() => checkAccountStatus(id, "generate"))).resolves.toMatchObject({
      allowed: true,
      accountStatus: "active",
    });
    await expect(t.run(() => isInGoodStanding(id))).resolves.toBe(true);
  });

  it("reads restriction and suspension windows", async () => {
    const id = await t.user();
    await setStatus(id, "restricted", { restricted_until: hours(5) });
    await expect(t.run(() => checkAccountStatus(id, "generate"))).resolves.toMatchObject({
      allowed: false,
      accountStatus: "restricted",
    });
    await expect(t.run(() => isInGoodStanding(id))).resolves.toBe(false);
    await setStatus(id, "suspended", { suspended_until: hours(-1) });
    await expect(t.run(() => checkAccountStatus(id, "generate"))).resolves.toMatchObject({
      allowed: true,
      reason: "Suspension period has expired",
    });
    await expect(t.run(() => isInGoodStanding(id))).resolves.toBe(true);
    await setStatus(id, "banned", { banned_at: hours(-2) });
    await expect(t.run(() => checkAccountStatus(id, "generate"))).resolves.toMatchObject({
      allowed: false,
      accountStatus: "banned",
    });
  });

  it("denies a feature on the per-account block-list, reporting the real status", async () => {
    const id = await t.user();
    await sql(
      t,
      "insert into user_feature_restrictions (user_id, feature, created_by) values ($1::uuid, 'generate', 'test')",
      [id]
    );
    await expect(t.run(() => checkAccountStatus(id, "generate"))).resolves.toMatchObject({
      allowed: false,
      accountStatus: "active",
    });
    await expect(
      t.run(() => checkAccountStatus(id, "upload_file"))
    ).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("provisions a user with no row, then allows from the stored row", async () => {
    const sub = uuid();
    await expect(
      t.run(() => checkAccountStatus(sub, "generate", { email: "n@e.w" }))
    ).resolves.toMatchObject({ allowed: true, accountStatus: "active" });
    expect(await userRow(t, sub)).toMatchObject({ email: "n@e.w" });
  });

  it("refuses as not provisioned when provisioning cannot be recorded", async () => {
    dataSpy().auditDown = true;
    await expect(
      t.run(() => checkAccountStatus(uuid(), "generate"))
    ).resolves.toMatchObject({ allowed: false, code: "account.not_provisioned" });
  });

  it("fails closed outside a tenant (the block-list is unreadable)", async () => {
    const id = await t.user();
    await runWithoutTenant(async () => {
      await expect(checkAccountStatus(id, "generate")).resolves.toMatchObject({
        allowed: false,
        accountStatus: "banned",
      });
      await expect(isInGoodStanding(id)).resolves.toBe(false);
    });
  });

  // ── Audit A-11: an erased account has no access, and its ban survives a new identity ──

  it("refuses an account that was erased (soft-deleted), whatever its status says", async () => {
    const id = await t.user();
    await sql(t, "update users set deleted_at = now() where id = $1::uuid", [id]);
    await expect(t.run(() => checkAccountStatus(id, "generate"))).resolves.toMatchObject({
      allowed: false,
      code: "account.not_found",
    });
    await expect(t.run(() => isInGoodStanding(id))).resolves.toBe(false);
  });

  it("never provisions an erased identity again — even after its row is purged", async () => {
    const id = uuid();
    await sql(
      t,
      "insert into user_deletions (user_id, requested_by, purged_at) values ($1::uuid, 'test', now())",
      [id]
    );
    await expect(
      t.run(() => ensureUserProvisioned(id, { email: "back@x.y" }))
    ).resolves.toBe("erased");
    expect(await userRow(t, id)).toBeUndefined();
    await expect(t.run(() => checkAccountStatus(id, "generate"))).resolves.toMatchObject({
      allowed: false,
      code: "account.not_found",
    });
  });

  it("starts a new identity banned when its address belongs to a banned account", async () => {
    const banned = await t.user();
    await sql(
      t,
      "update users set email = 'evader@x.y', account_status = 'banned', banned_at = now() where id = $1::uuid",
      [banned]
    );
    const fresh = uuid();
    await expect(
      t.run(() => ensureUserProvisioned(fresh, { email: " Evader@X.Y " }))
    ).resolves.toBe("created");
    expect(await userRow(t, fresh)).toMatchObject({
      account_status: "banned",
      status_changed_by: "platform:ban-carry-over",
    });
    const audit = await t.run(() => withTenantTx((tx) => auditRowsForUser(tx, fresh, 5)));
    expect(audit[0].details).toMatchObject({ banCarriedOver: true });
  });

  it("starts a new identity banned when its address was erased while banned (hash only)", async () => {
    const { emailHash } = jest.requireActual("@/platform/auth/user-provisioning");
    const h = emailHash("gone@x.y");
    await sql(
      t,
      "insert into user_deletions (user_id, requested_by, standing, email_hash, email_hash_key, email_hash_scheme) values ($1::uuid, 'test', 'banned', $2, $3, $4)",
      [uuid(), h.hash, h.keyId, h.scheme]
    );
    const fresh = uuid();
    await t.run(() => ensureUserProvisioned(fresh, { email: "gone@x.y" }));
    expect((await userRow(t, fresh))!.account_status).toBe("banned");
  });

  // Review 8 L6: the legacy form and the previous key still match, and a match is rehashed
  // under the current key (so the previous key can be retired).
  // Review 9 M6: and the pre-release review 7 form (HMAC of the address, no key id, no scheme
  // recorded) — matched by the address, never guessed at.
  it.each(["legacy", "previous", "review7"])(
    "honours a ban hashed in the %s form, and rehashes it under the current key",
    async (form) => {
      const actual = jest.requireActual("@/platform/auth/user-provisioning");
      const env = process.env as Record<string, string | undefined>;
      const saved = {
        key: env.ERASURE_HASH_KEY,
        previous: env.ERASURE_HASH_KEY_PREVIOUS,
      };
      env.ERASURE_HASH_KEY = "c".repeat(64);
      env.ERASURE_HASH_KEY_PREVIOUS = "p".repeat(64);
      try {
        const [current, previous, legacy, review7] = actual.erasureHashCandidates(
          `${form}-gone@x.y`
        );
        const old = form === "legacy" ? legacy : form === "review7" ? review7 : previous;
        const erased = uuid();
        await sql(
          t,
          "insert into user_deletions (user_id, requested_by, standing, email_hash, email_hash_key, email_hash_scheme) values ($1::uuid, 'test', 'banned', $2, $3, $4)",
          // An earlier build's row has no recorded scheme (only a key id identifies one).
          [erased, old.hash, old.keyId, old.keyId ? old.scheme : null]
        );
        const fresh = uuid();
        await t.run(() =>
          ensureUserProvisioned(fresh, { email: ` ${form.toUpperCase()}-Gone@X.Y ` })
        );
        expect((await userRow(t, fresh))!.account_status).toBe("banned");
        expect(
          await sql(
            t,
            "select email_hash, email_hash_key, email_hash_scheme from user_deletions where user_id = $1::uuid",
            [erased]
          )
        ).toEqual([
          {
            email_hash: current.hash,
            email_hash_key: current.keyId,
            email_hash_scheme: "hmac-of-sha256",
          },
        ]);
      } finally {
        if (saved.key === undefined) delete env.ERASURE_HASH_KEY;
        else env.ERASURE_HASH_KEY = saved.key;
        if (saved.previous === undefined) delete env.ERASURE_HASH_KEY_PREVIOUS;
        else env.ERASURE_HASH_KEY_PREVIOUS = saved.previous;
      }
    }
  );

  it("the retention job's upgrade turns every row recorded as unkeyed into the current key's, without the address", async () => {
    const actual = jest.requireActual("@/platform/auth/user-provisioning");
    const forms = actual.erasureHashCandidates("old-ban@x.y");
    const current = forms[0];
    const legacy = forms.find((f: { scheme: string }) => f.scheme === "sha256");
    const erased = uuid();
    await sql(
      t,
      "insert into user_deletions (user_id, requested_by, standing, email_hash, email_hash_scheme) values ($1::uuid, 'test', 'banned', $2, 'sha256')",
      [erased, legacy.hash]
    );
    expect(await t.run(() => actual.upgradeLegacyErasureHashes())).toBe(1);
    expect(
      await sql(
        t,
        "select email_hash, email_hash_key, email_hash_scheme from user_deletions where user_id = $1::uuid",
        [erased]
      )
    ).toEqual([
      {
        email_hash: current.hash,
        email_hash_key: current.keyId,
        email_hash_scheme: "hmac-of-sha256",
      },
    ]);
    expect(await t.run(() => actual.upgradeLegacyErasureHashes())).toBe(0);
    const fresh = uuid();
    await t.run(() => ensureUserProvisioned(fresh, { email: "old-ban@x.y" }));
    expect((await userRow(t, fresh))!.account_status).toBe("banned");
  });

  it("does not carry a ban to another tenant, or from an account that was not banned", async () => {
    const other = await createTestTenant();
    const banned = await t.user();
    await sql(
      t,
      "update users set email = 'tenantonly@x.y', account_status = 'banned' where id = $1::uuid",
      [banned]
    );
    const elsewhere = uuid();
    await other.run(() => ensureUserProvisioned(elsewhere, { email: "tenantonly@x.y" }));
    expect((await userRow(other, elsewhere))!.account_status).toBe("active");
    await sql(
      t,
      "insert into user_deletions (user_id, requested_by, standing, email_hash) values ($1::uuid, 'test', 'active', $2)",
      [uuid(), "a".repeat(64)]
    );
    const fresh = uuid();
    await t.run(() => ensureUserProvisioned(fresh, { email: "clean@x.y" }));
    expect((await userRow(t, fresh))!.account_status).toBe("active");
  });

  it("refuses a malformed deletion record (the hash's shape and the standing are checked)", async () => {
    await expect(
      sql(
        t,
        "insert into user_deletions (user_id, requested_by, standing, email_hash) values ($1::uuid, 'test', 'banned', 'plain@address')",
        [uuid()]
      )
    ).rejects.toThrow();
    await expect(
      sql(
        t,
        "insert into user_deletions (user_id, requested_by, standing) values ($1::uuid, 'test', 'emperor')",
        [uuid()]
      )
    ).rejects.toThrow();
  });

  it("does not see a user of another tenant (refused as not provisioned there)", async () => {
    const other = await createTestTenant();
    const id = await t.user();
    await expect(
      other.run(() => checkAccountStatus(id, "generate"))
    ).resolves.toMatchObject({ allowed: false, code: "account.not_provisioned" });
  });
});

// ── COPPA ───────────────────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} COPPA gate and records`, () => {
  it("allows a user not under enforcement, blocks one under it", async () => {
    const id = await t.user();
    await t.run(() => recordAgeVerification(id, "1990-01-01"));
    await expect(t.run(() => checkCoppaGate(id, "generate"))).resolves.toMatchObject({
      allowed: true,
      consentStatus: "not_required",
    });
    await expect(t.run(() => updateCoppaEnforcement(id, true))).resolves.toEqual({
      success: true,
    });
    expect((await userRow(t, id))!.coppa_enforcement_active).toBe(true);
    await expect(t.run(() => checkCoppaGate(id, "generate"))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("fails closed for an unknown user, and outside a tenant", async () => {
    await expect(t.run(() => checkCoppaGate(uuid(), "generate"))).resolves.toMatchObject({
      allowed: false,
    });
    await runWithoutTenant(async () => {
      await expect(updateCoppaEnforcement(uuid(), false)).resolves.toMatchObject({
        success: false,
      });
    });
  });

  it("records age verification, audited first", async () => {
    const id = await t.user();
    resetDataSpy();
    const out = await t.run(() => recordAgeVerification(id, "2000-06-15"));
    expect(out.success).toBe(true);
    expect(dataSpy().writes).toEqual([
      ["insert", "audit_log"],
      ["update", "users"],
    ]);
    const [row] = await sql(
      t,
      "select date_of_birth::text as dob, age_verified, age_verified_at, content_rating_level, parental_consent_status::text as pcs from users where id = $1::uuid",
      [id]
    );
    expect(row).toMatchObject({
      dob: "2000-06-15",
      age_verified: true,
      content_rating_level: out.result!.contentRatingLevel,
      pcs: "not_required",
    });
    expect(row.age_verified_at).toBeInstanceOf(Date);
  });

  it("marks a minor's consent pending", async () => {
    const id = await t.user();
    const year = new Date().getUTCFullYear() - 8;
    const out = await t.run(() => recordAgeVerification(id, `${year}-01-01`));
    expect(out.result?.requiresParentalConsent).toBe(true);
    const [row] = await sql(
      t,
      "select parental_consent_status::text as pcs from users where id = $1::uuid",
      [id]
    );
    expect(row.pcs).toBe("pending");
  });

  it("records a parental decision, audited as granted or denied", async () => {
    const id = await t.user();
    const child = `${new Date().getUTCFullYear() - 8}-01-01`;
    await t.run(() => recordAgeVerification(id, child));
    await expect(
      t.run(() => recordParentalConsent(id, "granted", "parent@example.com"))
    ).resolves.toEqual({ success: true });
    await t.run(() => recordParentalConsent(id, "denied"));
    const [row] = await sql(
      t,
      "select parental_consent_status::text as pcs, parental_consent_email from users where id = $1::uuid",
      [id]
    );
    expect(row).toEqual({ pcs: "denied", parental_consent_email: null });
    const audit = await t.run(() => withTenantTx((tx) => auditRowsForUser(tx, id, 10)));
    expect(audit.map((r) => r.action).sort()).toEqual([
      "consent_denied",
      "consent_granted",
      "profile_updated",
    ]);
  });

  // ── Audit X-16: the gate holds for an account whose age is unknown, and follows the age ──

  it("refuses consent-gated features to an account whose age was never recorded", async () => {
    const id = await t.user();
    // The core's consent-gated features and each registered module's (translate with the
    // translation module); a core-only app has no translate feature to gate.
    for (const feature of consentFeatureFallback()) {
      await expect(t.run(() => checkCoppaGate(id, feature))).resolves.toMatchObject({
        allowed: false,
        code: "account.age_unverified",
      });
    }
    await expect(
      t.run(() => checkCoppaGate(id, "update_profile"))
    ).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("puts a child under the gate at verification, and lifts it only with granted consent", async () => {
    const id = await t.user();
    await t.run(() =>
      recordAgeVerification(id, `${new Date().getUTCFullYear() - 9}-03-03`)
    );
    expect((await userRow(t, id))!.coppa_enforcement_active).toBe(true);
    await expect(t.run(() => checkCoppaGate(id, "stream"))).resolves.toMatchObject({
      allowed: false,
      code: "account.consent_required",
    });
    await t.run(() => recordParentalConsent(id, "granted"));
    await expect(t.run(() => checkCoppaGate(id, "stream"))).resolves.toMatchObject({
      allowed: true,
    });
    await t.run(() => recordParentalConsent(id, "denied"));
    expect((await userRow(t, id))!.coppa_enforcement_active).toBe(true);
  });

  it("records an age once: a child cannot re-declare as an adult", async () => {
    const id = await t.user();
    const child = `${new Date().getUTCFullYear() - 9}-03-03`;
    await t.run(() => recordAgeVerification(id, child));
    const again = await t.run(() => recordAgeVerification(id, "1980-01-01"));
    expect(again.success).toBe(false);
    const row = (await userRow(t, id))!;
    expect(row.content_rating_level).toBe(1);
    expect(row.coppa_enforcement_active).toBe(true);
  });

  it("refuses a consent decision for an account that needs none (an adult's, or an unverified one)", async () => {
    const adult = await t.user();
    await t.run(() => recordAgeVerification(adult, "1990-01-01"));
    await expect(
      t.run(() => recordParentalConsent(adult, "granted"))
    ).resolves.toMatchObject({
      success: false,
    });
    const unknown = await t.user();
    await expect(
      t.run(() => recordParentalConsent(unknown, "granted"))
    ).resolves.toMatchObject({ success: false });
    expect((await userRow(t, unknown))!.parental_consent_status).toBe("not_required");
  });

  it("changes nothing when the record cannot be written", async () => {
    const id = await t.user();
    dataSpy().auditDown = true;
    await expect(t.run(() => recordAgeVerification(id, "2000-06-15"))).resolves.toEqual({
      success: false,
      error: "audit unavailable",
    });
    await expect(t.run(() => recordParentalConsent(id, "granted"))).resolves.toEqual({
      success: false,
      error: "audit unavailable",
    });
    expect(dataSpy().writes).toEqual([]);
  });
});

// ── Profiles ────────────────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} profiles`, () => {
  it("reads the own profile with ISO timestamps", async () => {
    const id = await t.user("me");
    const p = await t.run(() => getOwnProfile(id));
    expect(p).toMatchObject({
      id,
      languagePreference: "en",
      timezone: "UTC",
      profileVisibility: "private",
      emailOptIn: false,
      lastLoginAt: null,
    });
    expect(p!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it("answers null for no row or a deleted one, and throws when the store fails", async () => {
    const id = await t.user();
    await sql(t, "update users set deleted_at = now() where id = $1::uuid", [id]);
    await expect(t.run(() => getOwnProfile(id))).resolves.toBeNull();
    await expect(t.run(() => getOwnProfile(uuid()))).resolves.toBeNull();
    await runWithoutTenant(async () => {
      await expect(getOwnProfile(uuid())).rejects.toThrow(/profile read failed/);
    });
  });

  it("updates only the fields sent, audited first", async () => {
    const id = await t.user();
    resetDataSpy();
    await expect(
      t.run(() =>
        updateProfile(id, {
          displayName: "New",
          profileVisibility: "public",
          displayNameVisibility: "public",
          emailOptIn: true,
        })
      )
    ).resolves.toEqual({ success: true });
    expect(dataSpy().writes).toEqual([
      ["insert", "audit_log"],
      ["update", "users"],
    ]);
    const p = await t.run(() => getOwnProfile(id));
    expect(p).toMatchObject({
      displayName: "New",
      profileVisibility: "public",
      displayNameVisibility: "public",
      emailOptIn: true,
      timezone: "UTC",
      avatarVisibility: "private",
    });
    await t.run(() =>
      updateProfile(id, {
        avatarUrl: "https://a/b.png",
        realName: "Real",
        languagePreference: "hi",
        timezone: "Asia/Kolkata",
        avatarVisibility: "public",
        languageVisibility: "public",
        timezoneVisibility: "friends",
        pushNotificationsEnabled: true,
      })
    );
    const q = await t.run(() => getOwnProfile(id));
    expect(q).toMatchObject({
      displayName: "New",
      avatarUrl: "https://a/b.png",
      realName: "Real",
      languagePreference: "hi",
      timezone: "Asia/Kolkata",
      avatarVisibility: "public",
      languageVisibility: "public",
      timezoneVisibility: "friends",
      pushNotificationsEnabled: true,
    });
  });

  it("refuses an empty update and reports a value the database rejects", async () => {
    const id = await t.user();
    await expect(t.run(() => updateProfile(id, {}))).resolves.toEqual({
      success: false,
      error: "No valid fields to update",
    });
    const bad = await t.run(() =>
      updateProfile(id, { profileVisibility: "everyone" as never })
    );
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/profile_visibility/);
  });

  it("changes nothing when the record cannot be written", async () => {
    const id = await t.user();
    dataSpy().auditDown = true;
    await expect(t.run(() => updateProfile(id, { displayName: "X" }))).resolves.toEqual({
      success: false,
      error: "audit unavailable",
    });
    expect((await t.run(() => getOwnProfile(id)))!.displayName).not.toBe("X");
  });

  it("public profile shows only public fields of a public profile", async () => {
    const id = await t.user();
    await expect(t.run(() => getPublicProfile(id))).resolves.toEqual({ id });
    await t.run(() =>
      updateProfile(id, {
        displayName: "Pub",
        timezone: "Europe/Paris",
        profileVisibility: "public",
        displayNameVisibility: "public",
      })
    );
    await expect(t.run(() => getPublicProfile(id))).resolves.toEqual({
      id,
      displayName: "Pub",
    });
    await expect(t.run(() => getPublicProfile(uuid()))).resolves.toBeNull();
    await runWithoutTenant(async () => {
      await expect(getPublicProfile(id)).resolves.toBeNull();
    });
  });

  it("an admin's view is recorded before it is returned; nothing for no profile", async () => {
    const id = await t.user("viewed");
    const admin = await t.user("admin");
    resetDataSpy();
    await expect(t.run(() => getProfileAsAdmin(admin, id))).resolves.toMatchObject({
      id,
    });
    expect(dataSpy().writes).toEqual([["insert", "audit_log"]]);
    resetDataSpy();
    await expect(t.run(() => getProfileAsAdmin(admin, uuid()))).resolves.toBeNull();
    expect(dataSpy().writes).toEqual([]);
    dataSpy().auditDown = true;
    await expect(t.run(() => getProfileAsAdmin(admin, id))).rejects.toBeInstanceOf(
      AuditWriteError
    );
  });
});

// ── Permissions ─────────────────────────────────────────────────────────────────────────

dbDescribe(`${SUITE} resolvePermissions`, () => {
  it("returns the role's permissions, by subject, in the current tenant", async () => {
    const id = await t.user();
    const [{ codes }] = await sql(
      t,
      `select array_agg(p.code order by p.code) as codes
           from users u join role_permissions rp on rp.role_id = u.role_id
           join permissions p on p.id = rp.permission_id where u.id = $1::uuid`,
      [id]
    );
    const result = await t.run(() => resolvePermissions(id));
    expect(result).toMatchObject({
      userId: id,
      roleName: "free",
      entitlementGroups: [],
    });
    expect([...result!.permissions].sort()).toEqual(codes);
    const someCode = (codes as string[])[0];
    await expect(t.run(() => hasPermission(id, someCode))).resolves.toBe(true);
    await expect(t.run(() => hasPermission(id, "no_such_permission"))).resolves.toBe(
      false
    );
  });

  it("includes an inherited role's permissions (none are seeded: equals the direct set)", async () => {
    const id = await t.user();
    const [{ n }] = await sql(
      t,
      `select count(distinct rp.permission_id)::int as n from users u
           join role_permissions rp on rp.role_id = u.role_id
            or rp.role_id in (select inherits_from_id from role_inheritance where role_id = u.role_id)
          where u.id = $1::uuid`,
      [id]
    );
    const result = await t.run(() => resolvePermissions(id));
    expect(result!.permissions).toHaveLength(n as number);
  });

  it("returns null for an unknown or deleted user, outside a tenant, and in another tenant", async () => {
    const id = await t.user();
    const other = await createTestTenant();
    await expect(other.run(() => resolvePermissions(id))).resolves.toBeNull();
    await expect(t.run(() => resolvePermissions("sub-none"))).resolves.toBeNull();
    await runWithoutTenant(async () => {
      await expect(resolvePermissions(id)).resolves.toBeNull();
      await expect(hasPermission(id, "x")).resolves.toBe(false);
    });
    await sql(t, "update users set deleted_at = now() where id = $1::uuid", [id]);
    await expect(t.run(() => resolvePermissions(id))).resolves.toBeNull();
  });

  it("ignores revoked and expired grants (the entitlement read runs; no active group is seeded)", async () => {
    const id = await t.user();
    const result = await t.run(() => resolvePermissions(id));
    expect(result!.entitlementGroups).toEqual([]);
  });
});

// ── Isolation (D8) ──────────────────────────────────────────────────────────────────────

// Not the generic kit: users.id (= the Cognito subject) is unique platform-wide, so one
// subject has a row in one tenant only — "the same key in two tenants is two records" does
// not hold by design of the key (see the report). What must hold is below.
dbDescribe(`${SUITE} tenant isolation: users (ADR-053 D8)`, () => {
  it("a user provisioned under A is invisible under B", async () => {
    const [a, b] = [await createTestTenant(), await createTestTenant()];
    const sub = uuid();
    await expect(a.run(() => ensureUserProvisioned(sub))).resolves.toBe("created");
    await expect(a.run(() => getOwnProfile(sub))).resolves.toMatchObject({ id: sub });
    await expect(b.run(() => getOwnProfile(sub))).resolves.toBeNull();
    await expect(b.run(() => getPublicProfile(sub))).resolves.toBeNull();
    await expect(b.run(() => resolvePermissions(sub))).resolves.toBeNull();
  });

  it("B cannot change A's user", async () => {
    const [a, b] = [await createTestTenant(), await createTestTenant()];
    const id = await a.user();
    await b.run(async () => {
      await updateProfile(id, { displayName: "changed by B" });
      await updateCoppaEnforcement(id, true);
      await recordParentalConsent(id, "denied");
    });
    const row = await userRow(a, id);
    expect(row).toMatchObject({ coppa_enforcement_active: false });
    expect(row!.display_name).not.toBe("changed by B");
  });

  it("the same subject first seen under B is not created there (fail closed)", async () => {
    const [a, b] = [await createTestTenant(), await createTestTenant()];
    const sub = uuid();
    await a.run(() => ensureUserProvisioned(sub));
    // The insert conflicts with A's row and does nothing; B still has no row, and provisioning
    // says so: "failed" — the identity is held outside B (it answered "existing" before the
    // every-key arbiter, which no row of B's backed).
    await expect(b.run(() => ensureUserProvisioned(sub))).resolves.toBe("failed");
    await expect(b.run(() => checkAccountStatus(sub, "generate"))).resolves.toMatchObject(
      {
        allowed: false,
        code: "account.not_provisioned",
      }
    );
  });
});

dbDescribe(SUITE, () => {
  it("users: nothing is read or written without a tenant", async () => {
    await runWithoutTenant(async () => {
      await expect(withTenantTx(async () => 1)).rejects.toThrow(TenantContextError);
      await expect(ensureUserProvisioned(uuid())).resolves.toBe("failed");
      await expect(getOwnProfile(uuid())).rejects.toThrow(/profile read failed/);
    });
  });
});

// ── Erasure-hash schemes, recorded (review 9 M6) ────────────────────────────────────────

dbDescribe(`${SUITE} erasure-hash schemes`, () => {
  // Review 9 M6: a row the review 7 build wrote (HMAC of the address, no key id) was read as the
  // unkeyed form and "upgraded" into a hash that matched nothing — the ban was lost. Now only a
  // row recorded as 'sha256' is upgraded; an unmarked row, or one recorded as 'hmac', is left as
  // it is, and still carries its ban when the address signs up again (and is rehashed then).
  it.each([
    ["unmarked", null],
    ["recorded as the review 7 form", "hmac"],
  ])("never upgrades a row %s: its ban survives", async (_name, scheme) => {
    const actual = jest.requireActual("@/platform/auth/user-provisioning");
    const forms = actual.erasureHashCandidates("r7-ban@x.y");
    const review7 = forms.find(
      (f: { scheme: string; keyId: string | null }) => f.scheme === "hmac"
    );
    const erased = uuid();
    await sql(
      t,
      "insert into user_deletions (user_id, requested_by, standing, email_hash, email_hash_scheme) values ($1::uuid, 'test', 'banned', $2, $3)",
      [erased, review7.hash, scheme]
    );
    expect(await t.run(() => actual.upgradeLegacyErasureHashes())).toBe(0);
    expect(
      await sql(t, "select email_hash from user_deletions where user_id = $1::uuid", [
        erased,
      ])
    ).toEqual([{ email_hash: review7.hash }]);
    const fresh = uuid();
    await t.run(() => ensureUserProvisioned(fresh, { email: "R7-Ban@x.y" }));
    expect((await userRow(t, fresh))!.account_status).toBe("banned");
    expect(
      await sql(
        t,
        "select email_hash, email_hash_scheme from user_deletions where user_id = $1::uuid",
        [erased]
      )
    ).toEqual([{ email_hash: forms[0].hash, email_hash_scheme: "hmac-of-sha256" }]);
  });

  it("a key id without the keyed scheme is refused by the database", async () => {
    await expect(
      sql(
        t,
        "insert into user_deletions (user_id, requested_by, standing, email_hash, email_hash_key, email_hash_scheme) values ($1::uuid, 'test', 'banned', $2, 'abcdefabcdefabcd', 'sha256')",
        [uuid(), "a".repeat(64)]
      )
    ).rejects.toThrow(/user_deletions_email_hash_scheme_known/);
  });
});
