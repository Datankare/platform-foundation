/**
 * @jest-environment node
 */
/**
 * __tests__/db/erasure-reconciliation.db.test.ts — every erasure completes, whatever fails on the
 * way (TASK-193, audit B-6, B-7, A-16, D-10)
 *
 * Faults are injected into each step of the erasure — the record's write, an app module's soft
 * delete and hard purge, the identity provider's delete — and the invariants are read back from
 * Postgres:
 *
 *   - an account marked deleted always has its erasure record (deleted_at ⇒ user_deletions): the
 *     anonymisation and the record are one transaction (a failed record leaves the account as it
 *     was, so the person can try again), and the job records any account deleted without one;
 *   - an erasure is marked complete (purged_at) only when the database and every store outside it
 *     are erased; one still pending is retried until it is;
 *   - erasures that always fail never hold the others back: each failure is deferred with a
 *     growing interval, and a good one behind a full batch of failing ones is purged on the next
 *     run; one that keeps failing is alerted;
 *   - the soft delete clears every personal column of the account at once (A-16), except the ones
 *     SOFT_DELETE_KEPT keeps, each with its reason.
 *
 * Shown failing on the code before TASK-193: a fault on the record's insert left the account
 * anonymised and marked deleted with no record (and the user refused at sign-in); three failing
 * erasures at the head of a batch of three held the good one back on every run; the parent's
 * address and the ban reason stayed after the soft delete.
 */

const FAULTS: RegExp[] = [];
jest.mock("@/platform/data", () => {
  const actual = jest.requireActual(
    "@/platform/data"
  ) as typeof import("@/platform/data");
  const faulty = (tx: import("@/platform/data").Tx): import("@/platform/data").Tx => ({
    tenantId: tx.tenantId,
    async query(text: string, values?: unknown[]) {
      const faults = (globalThis as { __erasureFaults?: RegExp[] }).__erasureFaults ?? [];
      if (faults.some((f) => f.test(text))) throw new Error("injected fault");
      return tx.query(text, values) as never;
    },
  });
  return {
    ...actual,
    withTenantTx: <T>(fn: (tx: import("@/platform/data").Tx) => Promise<T>) =>
      actual.withTenantTx((tx) => fn(faulty(tx))),
  };
});
(globalThis as { __erasureFaults?: RegExp[] }).__erasureFaults = FAULTS;

const mockAlerts: { name: string; count?: number }[] = [];
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (a: { name: string; count?: number }) => mockAlerts.push(a),
}));

import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { withOwnerTx } from "@/platform/data";
import {
  hardPurgeUser,
  purgeDueErasures,
  reconcileErasures,
  registerDeletionModule,
  retryExternalErasures,
  SOFT_DELETE_CLEARED,
  SOFT_DELETE_KEPT,
  softDeleteUser,
  PURGE_ALERT_ATTEMPTS,
} from "@/platform/auth/gdpr-deletion";
import {
  registerExternalErasure,
  resetExternalErasures,
  resetIdentityPoolCheck,
} from "@/platform/gdpr/external-erasure";
import { initAuth } from "@/platform/auth/auth-init";
import {
  decideErasureAttestation,
  requestErasureAttestation,
} from "@/platform/gdpr/erasure-attestation";
import { getAuthProvider, registerAuthProvider } from "@/platform/auth/config";
import type { AuthProvider } from "@/platform/auth/provider";

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

let t: TestTenant;
/** Accounts whose app module fails, as a module erroring for some users would. */
const failingModuleFor = new Set<string>();
/** Subjects the identity provider refuses to delete (its credentials lack the permission). */
const identityDownFor = new Set<string>();

const recordOf = async (userId: string) =>
  (
    await owner<{
      purged_at: Date | null;
      purge_attempts: number;
      purge_retry_at: Date | null;
      last_purge_error: string | null;
      external_erasures: Record<string, { doneAt?: string; attempts?: number }>;
    }>("select * from user_deletions where user_id = $1::uuid", [userId])
  ).rows[0];

dbDescribe("erasure reconciliation, with faults injected (TASK-193)", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    registerDeletionModule({
      moduleName: "dbtest-app",
      description: "an app's own table, failing for some accounts",
      tables: [],
      softDelete: async (id) =>
        failingModuleFor.has(id)
          ? { success: false, error: "app table down" }
          : { success: true },
      hardPurge: async (id) =>
        failingModuleFor.has(id)
          ? { success: false, error: "app table down" }
          : { success: true },
    });
    registerExternalErasure({
      name: "identity-provider",
      holds: "the sign-in identity (a test double of the administrative delete)",
      async erase(subject) {
        return subject.sub && identityDownFor.has(subject.sub)
          ? {
              done: false,
              error: "AccessDeniedException: not authorized for AdminDeleteUser",
            }
          : { done: true };
      },
    });
  });

  afterAll(async () => {
    resetExternalErasures();
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  beforeEach(() => {
    FAULTS.length = 0;
    failingModuleFor.clear();
    identityDownFor.clear();
    mockAlerts.length = 0;
  });

  it("a fault on the record's write leaves the account as it was — never deleted without its record (B-6, D-10)", async () => {
    const user = await t.user("record-fault");
    FAULTS.push(/^\s*insert into user_deletions/i);
    const r = await t.run(() => softDeleteUser(user, user));
    expect(r.success).toBe(false);
    const { rows } = await owner<{ deleted_at: Date | null; email: string | null }>(
      "select deleted_at, email from users where id = $1::uuid",
      [user]
    );
    expect(rows[0].deleted_at).toBeNull();
    expect(rows[0].email).not.toBeNull();
    expect(await recordOf(user)).toBeUndefined();
    // Retried once the store is back: erased, and recorded.
    FAULTS.length = 0;
    expect((await t.run(() => softDeleteUser(user, user))).success).toBe(true);
    expect(await recordOf(user)).toBeDefined();
  });

  it("an app module's failure leaves the record, so the erasure is still completed later", async () => {
    const user = await t.user("module-fault");
    failingModuleFor.add(user);
    const r = await t.run(() => softDeleteUser(user, user));
    expect(r).toMatchObject({ success: false });
    expect(await recordOf(user)).toBeDefined();
  });

  it("an account marked deleted without a record is recorded by the job, and purged (B-6)", async () => {
    const user = await t.user("orphan");
    await owner(
      "update users set deleted_at = now() - interval '40 days', email = null where id = $1::uuid",
      [user]
    );
    expect(await recordOf(user)).toBeUndefined();
    expect(await t.run(() => reconcileErasures("job:test"))).toBeGreaterThanOrEqual(1);
    const record = await recordOf(user);
    expect(record).toBeDefined();
    expect(mockAlerts.map((a) => a.name)).toContain("gdpr.erasure_unrecorded");
    // Its purge was due 30 days after it was deleted: the next run completes it.
    const run = await t.run(() => purgeDueErasures("job:test", 100));
    expect(run.purged).toBeGreaterThanOrEqual(1);
    expect((await recordOf(user)).purged_at).not.toBeNull();
    const { rowCount } = await owner("select 1 from users where id = $1::uuid", [user]);
    expect(rowCount).toBe(0);
    // The invariant over the whole tenant: no account marked deleted without its record.
    const { rows } = await owner(
      `select u.id from users u where u.tenant_id = $1 and u.deleted_at is not null
          and not exists (select 1 from user_deletions d where d.user_id = u.id)`,
      [t.id]
    );
    expect(rows).toEqual([]);
  });

  it("is never marked complete while the identity still exists; retried until it is gone (B-8, D-9)", async () => {
    const user = await t.user("identity-down");
    const { rows } = await owner<{ sub: string }>(
      "select cognito_sub as sub from users where id = $1::uuid",
      [user]
    );
    identityDownFor.add(rows[0].sub);
    const erased = await t.run(() => softDeleteUser(user, user));
    expect(erased).toMatchObject({
      success: true,
      externalPending: ["identity-provider"],
    });
    expect((await recordOf(user)).external_erasures["identity-provider"]).toMatchObject({
      attempts: 1,
    });
    // The purge empties the database, but the erasure is not complete.
    const purged = await t.run(() => hardPurgeUser(user));
    expect(purged.success).toBe(false);
    expect(purged.errors.join(" ")).toMatch(/identity-provider/);
    expect((await recordOf(user)).purged_at).toBeNull();
    // Retried (when its retry is due) until done.
    await owner(
      `update user_deletions
          set external_erasures = jsonb_set(external_erasures, '{identity-provider,retryAt}', to_jsonb(now() - interval '1 minute'))
        where user_id = $1::uuid`,
      [user]
    );
    identityDownFor.clear();
    const retried = await t.run(() => retryExternalErasures(100));
    expect(retried.done).toBeGreaterThanOrEqual(1);
    expect(
      (await recordOf(user)).external_erasures["identity-provider"].doneAt
    ).toBeTruthy();
    expect((await t.run(() => hardPurgeUser(user))).success).toBe(true);
    expect((await recordOf(user)).purged_at).not.toBeNull();
  });

  it("erasures that always fail never hold a good one back; one that keeps failing is alerted (B-7)", async () => {
    const failing = [await t.user("bad-1"), await t.user("bad-2"), await t.user("bad-3")];
    const good = await t.user("good");
    for (const u of [...failing, good]) {
      expect((await t.run(() => softDeleteUser(u, u))).success).toBe(true);
    }
    // All due; the failing ones are the oldest — the head of a batch of three.
    await owner(
      `update user_deletions set purge_after = now() - interval '2 days' where user_id = any($1::uuid[]);`,
      [failing]
    );
    await owner(
      "update user_deletions set purge_after = now() - interval '1 day' where user_id = $1::uuid",
      [good]
    );
    for (const u of failing) failingModuleFor.add(u);
    const first = await t.run(() => purgeDueErasures("job:test", 3));
    expect(first).toMatchObject({ due: 3, failed: 3 });
    for (const u of failing) {
      const r = await recordOf(u);
      expect(r.purge_attempts).toBe(1);
      expect(r.purge_retry_at).not.toBeNull();
      expect(r.last_purge_error).toBe("dbtest-app");
    }
    const second = await t.run(() => purgeDueErasures("job:test", 3));
    expect(second.purged).toBeGreaterThanOrEqual(1);
    expect((await recordOf(good)).purged_at).not.toBeNull();
    // One that has failed often enough is alerted.
    await owner(
      "update user_deletions set purge_attempts = $2, purge_retry_at = null where user_id = $1::uuid",
      [failing[0], PURGE_ALERT_ATTEMPTS]
    );
    mockAlerts.length = 0;
    await t.run(() => purgeDueErasures("job:test", 3));
    expect(mockAlerts.map((a) => a.name)).toContain("gdpr.erasure_stuck");
  });

  it("the soft delete clears every personal column at once, except the ones kept with a reason (A-16)", async () => {
    const user = await t.user("personal-columns");
    await owner(
      `update users set display_name = 'Jane Sentinel', real_name = 'Jane Q Sentinel',
              avatar_url = 'https://x/jane.png', date_of_birth = '2014-01-01',
              parental_consent_email = 'parent-sentinel@example.com', ban_reason = 'sentinel reason',
              timezone = 'Asia/Kolkata', language_preference = 'hi', last_login_at = now()
        where id = $1::uuid`,
      [user]
    );
    expect((await t.run(() => softDeleteUser(user, user))).success).toBe(true);
    const { rows: columns } = await owner<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'users'
          and data_type in ('text', 'character varying', 'date', 'jsonb', 'json', 'inet', 'uuid', 'ARRAY')`
    );
    const unclassified = columns
      .map((c) => c.column_name)
      .filter((c) => !SOFT_DELETE_CLEARED.includes(c) && !SOFT_DELETE_KEPT[c]);
    expect(unclassified).toEqual([]);
    const { rows } = await owner<Record<string, unknown>>(
      "select * from users where id = $1::uuid",
      [user]
    );
    const after = rows[0];
    const defaults: Record<string, unknown> = {
      display_name: "[deleted]",
      timezone: "UTC",
      language_preference: "en",
    };
    for (const c of SOFT_DELETE_CLEARED) {
      expect([c, after[c]]).toEqual([c, defaults[c] ?? null]);
    }
    expect(JSON.stringify(after)).not.toMatch(/sentinel/i);
  });
});

/**
 * Review round 1 (items 1–3, 10): the identity step itself (IDENTITY_ERASURE), against a fake
 * identity pool behind the provider's administrative delete — a federated identity (its username
 * is not its subject), a local one, an account bound by its id (no subject recorded), and one
 * erased while another pool was current (not found here: never counted erased).
 */
dbDescribe("the identity step, against a fake pool (TASK-193 rounds 1 and 2)", () => {
  let u: TestTenant;
  let base: AuthProvider;
  let pool = "pool-current";
  let down = false;
  /** The pool's identities: subject → username. */
  const identities = new Map<string, string>();

  beforeAll(async () => {
    await connectTestDatabase();
    u = await createTestTenant();
    resetExternalErasures();
    initAuth();
    base = getAuthProvider();
    const fake = Object.assign(Object.create(base) as AuthProvider, {
      // Resolved by subject, as a pool's ListUsers lookup does: a federated identity's username
      // (Google_…) is not its subject.
      async adminDeleteUser(sub: string) {
        if (down) return { success: false, error: "TooManyRequestsException" };
        if (!identities.has(sub)) return { success: true, notFound: true };
        identities.delete(sub);
        return { success: true };
      },
      identityPoolId: () => pool,
      confirmIdentityPool: async () => true,
      // Proven present: the pool has it (S2 round 2).
      identityInPool: async (sub: string) => identities.has(sub),
    });
    registerAuthProvider(fake);
  });

  afterAll(async () => {
    registerAuthProvider(base);
    resetIdentityPoolCheck();
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  beforeEach(() => {
    pool = "pool-current";
    down = false;
    resetIdentityPoolCheck();
    mockAlerts.length = 0;
  });

  const subOf = async (id: string) =>
    (
      await owner<{ sub: string | null }>(
        "select cognito_sub as sub from users where id = $1::uuid",
        [id]
      )
    ).rows[0].sub;

  it("deletes a federated and a local identity, recorded as done, in the pool recorded", async () => {
    const federated = await u.user("federated");
    const local = await u.user("local");
    identities.set((await subOf(federated))!, "Google_118234567890");
    identities.set((await subOf(local))!, (await subOf(local))!);
    for (const id of [federated, local]) {
      expect(await u.run(() => softDeleteUser(id, id))).toMatchObject({ success: true });
      expect(await u.run(() => hardPurgeUser(id))).toMatchObject({ success: true });
      const r = await owner<{ pool: string; done: string | null; purged: boolean }>(
        `select identity_pool as pool, external_erasures->'identity-provider'->>'doneAt' as done,
                purged_at is not null as purged
           from user_deletions where user_id = $1::uuid`,
        [id]
      );
      expect(r.rows[0]).toMatchObject({ pool: "pool-current", purged: true });
      expect(r.rows[0].done).toBeTruthy();
    }
    expect(identities.size).toBe(0);
  });

  it("an account bound by its id (no subject recorded) has its identity deleted by the id (item 2)", async () => {
    const legacy = await u.user("legacy");
    await owner("update users set cognito_sub = null where id = $1::uuid", [legacy]);
    identities.set(legacy, legacy);
    expect(await u.run(() => softDeleteUser(legacy, legacy))).toMatchObject({
      success: true,
    });
    expect(identities.has(legacy)).toBe(false);
  });

  it("not found in a pool other than the one recorded: pending and alerted, never complete (item 3)", async () => {
    const moved = await u.user("other-pool");
    // Erased while the old pool was current — proven present there, so that pool is recorded —
    // and its delete failed then …
    pool = "pool-old";
    down = true;
    identities.set((await subOf(moved))!, "someone");
    expect(await u.run(() => softDeleteUser(moved, moved))).toMatchObject({
      success: true,
      externalPending: ["identity-provider"],
    });
    expect(
      (
        await owner<{ pool: string }>(
          "select identity_pool as pool from user_deletions where user_id = $1::uuid",
          [moved]
        )
      ).rows[0].pool
    ).toBe("pool-old");
    down = false;
    // … and now another pool is current, where it is not found.
    pool = "pool-current";
    identities.delete((await subOf(moved))!);
    await owner(
      `update user_deletions
          set external_erasures = jsonb_set(external_erasures, '{identity-provider,retryAt}', to_jsonb(now() - interval '1 minute'))
        where user_id = $1::uuid`,
      [moved]
    );
    await u.run(() => retryExternalErasures(100));
    const { rows } = await owner<{
      entry: { doneAt?: string; poolUnverified?: boolean };
    }>(
      "select external_erasures->'identity-provider' as entry from user_deletions where user_id = $1::uuid",
      [moved]
    );
    expect(rows[0].entry.doneAt).toBeUndefined();
    expect(rows[0].entry.poolUnverified).toBe(true);
    expect(mockAlerts.map((a) => a.name)).toContain("gdpr.identity_pool_unverified");
    expect((await u.run(() => hardPurgeUser(moved))).success).toBe(false);
  });

  const stepOf = async (id: string) =>
    (
      await owner<{ entry: Record<string, unknown>; pool: string | null }>(
        "select external_erasures->'identity-provider' as entry, identity_pool as pool from user_deletions where user_id = $1::uuid",
        [id]
      )
    ).rows[0];
  /** An old-pool account never re-linked: its identity is not in the current pool. */
  const unrelinked = async (name: string) => {
    const id = await u.user(name);
    await u.run(() => softDeleteUser(id, id));
    return id;
  };
  const dueNow = (id: string) =>
    owner(
      `update user_deletions
          set external_erasures = jsonb_set(external_erasures, '{identity-provider,retryAt}', to_jsonb(now() - interval '1 minute'))
        where user_id = $1::uuid`,
      [id]
    );

  it("an old-pool account never re-linked, erased now: no pool recorded, unverified, not complete (S2 round 2)", async () => {
    const old = await unrelinked("unrelinked");
    const r = await stepOf(old);
    // Not proven present in the current pool: no pool recorded, so "not found" proves nothing.
    expect(r.pool).toBeNull();
    expect(r.entry).toMatchObject({ poolUnverified: true });
    expect(r.entry.doneAt).toBeUndefined();
    // Erased again: still none (no coalesce to the current pool).
    await u.run(() => softDeleteUser(old, old));
    expect((await stepOf(old)).pool).toBeNull();
    expect((await u.run(() => hardPurgeUser(old))).success).toBe(false);
  });

  it("an open attestation is dropped when the job records another failure, and approval re-checks the step (S2 round 2)", async () => {
    const a = { userId: await u.user("operator-d") };
    const b = { userId: await u.user("operator-e") };
    // (1) The job's next attempt is refused (another failure kind): the request goes.
    const first = await unrelinked("attest-then-refused");
    const t1 = { tenantId: u.id, userId: first };
    expect(
      await u.run(() =>
        requestErasureAttestation(a, t1, "deleted_in_old_pool", "deleted by hand")
      )
    ).toMatchObject({ ok: true });
    await dueNow(first);
    down = true;
    await u.run(() => retryExternalErasures(100));
    down = false;
    expect((await stepOf(first)).entry.attestationRequest).toBeUndefined();
    expect(await u.run(() => decideErasureAttestation(b, t1, true, ""))).toMatchObject({
      ok: false,
      code: "tenant.state_conflict",
    });
    expect((await stepOf(first)).entry.doneAt).toBeUndefined();
    // (2) A request on a step that is no longer unverifiable is not approved.
    const second = await unrelinked("attest-then-changed");
    const t2 = { tenantId: u.id, userId: second };
    expect(
      await u.run(() =>
        requestErasureAttestation(a, t2, "pool_decommissioned", "pool gone")
      )
    ).toMatchObject({ ok: true });
    await owner(
      `update user_deletions
          set external_erasures = jsonb_set(external_erasures, '{identity-provider}', (external_erasures->'identity-provider') - 'poolUnverified')
        where user_id = $1::uuid`,
      [second]
    );
    expect(await u.run(() => decideErasureAttestation(b, t2, true, ""))).toMatchObject({
      ok: false,
      code: "tenant.state_conflict",
    });
    expect((await stepOf(second)).entry.doneAt).toBeUndefined();
  });

  it("an unverifiable step stays pending until two operators attest it; each step audited (owner decision)", async () => {
    const since = (await owner<{ now: Date }>("select clock_timestamp() as now")).rows[0]
      .now;
    const gone = await unrelinked("decommissioned-pool");
    const step = async () => (await stepOf(gone)).entry;
    expect(await step()).toMatchObject({ poolUnverified: true });
    const a = { userId: await u.user("operator-a") };
    const b = { userId: await u.user("operator-b") };
    const target = { tenantId: u.id, userId: gone };

    // A reason outside the fixed list, or no note, is refused.
    expect(
      await u.run(() => requestErasureAttestation(a, target, "trust me", "checked"))
    ).toMatchObject({ ok: false, code: "tenant.invalid" });
    // Asked; still pending: the purge does not complete, the retry does not close it.
    expect(
      await u.run(() =>
        requestErasureAttestation(
          a,
          target,
          "pool_decommissioned",
          "old pool deleted 2026-10"
        )
      )
    ).toMatchObject({ ok: true });
    expect((await step()).doneAt).toBeUndefined();
    expect((await u.run(() => hardPurgeUser(gone))).success).toBe(false);
    // The asking operator cannot approve it.
    expect(
      await u.run(() => decideErasureAttestation(a, target, true, ""))
    ).toMatchObject({ ok: false, code: "tenant.self_approval" });
    expect((await step()).doneAt).toBeUndefined();
    // A second operator approves: done, attested, the erasure completes.
    expect(
      await u.run(() => decideErasureAttestation(b, target, true, "confirmed"))
    ).toMatchObject({
      ok: true,
    });
    expect(await step()).toMatchObject({
      doneAt: expect.any(String),
      attested: { by: b.userId, requestedBy: a.userId, reason: "pool_decommissioned" },
    });
    expect((await step()).attestationRequest).toBeUndefined();
    expect((await u.run(() => hardPurgeUser(gone))).success).toBe(true);
    // Audited: the request, the refused self-approval, the approval.
    const { rows: audit } = await owner<{
      type: string;
      outcome: string;
      note: string | null;
    }>(
      `select details->>'type' as type, details->>'outcome' as outcome, details->>'note' as note
         from audit_log
        where tenant_id = $1 and details->>'type' like 'external_erasure_attestation_%'
          and created_at >= $2
        order by created_at, id`,
      [u.id, since]
    );
    // Recorded before each act ("attempted"); a refused act is recorded "failed" as well.
    expect(audit.map((r) => [r.type, r.outcome])).toEqual([
      ["external_erasure_attestation_requested", "attempted"],
      ["external_erasure_attestation_approved", "attempted"],
      ["external_erasure_attestation_approved", "failed"],
      ["external_erasure_attestation_approved", "attempted"],
    ]);
    // The note is the audit record's alone, never the erasure record's.
    expect(JSON.stringify(await step())).not.toMatch(/old pool deleted/);
  });

  it("a verified step cannot be attested", async () => {
    const fine = await u.user("verified");
    identities.set((await subOf(fine))!, (await subOf(fine))!);
    await u.run(() => softDeleteUser(fine, fine));
    const operator = { userId: await u.user("operator-c") };
    expect(
      await u.run(() =>
        requestErasureAttestation(
          operator,
          { tenantId: u.id, userId: fine },
          "identity_never_existed",
          "should be refused"
        )
      )
    ).toMatchObject({ ok: false, code: "tenant.state_conflict" });
  });
});
