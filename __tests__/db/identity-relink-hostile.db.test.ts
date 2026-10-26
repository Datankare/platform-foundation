/**
 * @jest-environment node
 */
/**
 * Review 15 of the identity re-link (TASK-174, ADR-012 amendment), against the replayed Postgres:
 * the reviewer's hostile proofs (review15 __tests__/db/r15-hostile.db.test.ts), kept as
 * regression tests asserting the FIXED behaviour, and the tests of each fix.
 *
 *   H1  an account already bound to an identity of the current pool is never moved to whoever
 *       now holds its stale address; nor one re-linked in this pool before; nor is an account
 *       made in the new pool (--created-before) ever a target;
 *   M1  an unconfirmed sign-up, an account made after the move, a Kelvin-sign lookalike — none
 *       blocks a staff re-link; the one pre-move account is the target whatever its own
 *       users.email_verified (TASK-176: the pool verifies the address), and of several unverified
 *       ones only the one the operator names by its id;
 *   M2  a cache failure after the commit is reported as applied, with a warning (exit 5);
 *   M3  one identity planned onto two accounts (two tenants) — both refused, no unique violation;
 *   M4  chunked application: each chunk atomic, the report says which applied, a rerun completes;
 *   L3  the old subject's sign-in events record no actor;
 *   L6  bulk asks the pool for an address as stored, not only in lower case;
 *   L7  a stray that gains data in a table without a foreign key to users is not merged.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-relink-hostile",
}));

import { randomUUID } from "node:crypto";
import { withOwnerTx } from "@/platform/data";
import { clearConfigCache } from "@/platform/auth/platform-config";
import { resolvePermissions } from "@/platform/auth/permissions";
import {
  clearPermissionsCache,
  invalidatePermissions,
} from "@/platform/auth/permissions-cache";
import { auditableAccountId, resolveAccount } from "@/platform/auth/account-identity";
import { ensureUserProvisioned } from "@/platform/auth/user-provisioning";
import type {
  DirectoryUser,
  IdentityDirectory,
} from "@/platform/auth/identity-directory";
import {
  relinkIdentities,
  type AccountPlan,
  type RelinkRequest,
} from "@/platform/auth/identity-relink";
import { EXIT, runRelinkCommand } from "@/platform/auth/identity-relink-command";
import { resetRateLimiter } from "@/platform/rate-limit";
import {
  DB_ENABLED,
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { insertUser, seededRoleId } from "../helpers/db-admin";

type Row = Record<string, unknown>;

// ── The fake pool ───────────────────────────────────────────────────────────────────────────

class FakePool implements IdentityDirectory {
  readonly poolId = "us-east-1_NewPool15";
  users: DirectoryUser[] = [];
  asked: string[] = [];
  askedSubs: string[] = [];
  async findByEmail(email: string): Promise<readonly DirectoryUser[]> {
    this.asked.push(email);
    // Like ListUsers' `email = "…"`: exact, case-sensitive.
    return this.users.filter((u) => u.email === email);
  }
  /** Like ListUsers' `sub = "…"`: exact. */
  async findBySub(sub: string): Promise<readonly DirectoryUser[]> {
    this.askedSubs.push(sub);
    return this.users.filter((u) => u.sub === sub);
  }
  add(email: string, over: Partial<DirectoryUser> = {}): DirectoryUser {
    // TASK-177: the subject is the sub, never the username — and the two differ here (as for
    // a federated user, Google_…), so binding the username would fail every test.
    const sub = over.sub ?? randomUUID();
    const username = over.username ?? `user-${randomUUID()}`;
    const u: DirectoryUser = {
      sub,
      username,
      email,
      emailVerified: true,
      enabled: true,
      status: "CONFIRMED",
      providers: [],
      tenantId: null,
      ...over,
    };
    this.users.push(u);
    return u;
  }
  remove(subject: string): void {
    this.users = this.users.filter((u) => u.sub !== subject);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

let a: TestTenant;
let pool: FakePool;
const invalidated: string[] = [];
const run = randomUUID().slice(0, 8);
let n = 0;
const address = (label: string) => `${label}.${run}.${++n}@relink15.example`;

const HOUR = 3_600_000;
/** The pool move: an hour ago. Old-pool accounts are a day old; new-pool ones are made now. */
const movedAt = () => new Date(Date.now() - HOUR).toISOString();
const dayAgo = () => new Date(Date.now() - 24 * HOUR).toISOString();

const deps = (over: Record<string, unknown> = {}) => ({
  directory: pool,
  invalidate: async (s: string) => {
    invalidated.push(s);
    await invalidatePermissions(s);
  },
  ...over,
});

const request = (over: Partial<RelinkRequest>): RelinkRequest => ({
  apply: false,
  createdBefore: movedAt(),
  operator: "Raman (owner)",
  osUser: "raman",
  host: "trusted-mac",
  reason: "review 15: pool replaced",
  ...over,
});

/** A staff account of `t` made in the old pool: a day old, its address verified there. */
async function staff(
  t: TestTenant,
  email: string,
  over: { role?: string; verified?: boolean; createdAt?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await insertUser(t, {
    id,
    cognitoSub: id,
    email,
    roleId: await seededRoleId(over.role ?? "super_admin"),
    createdAt: over.createdAt ?? dayAgo(),
    emailVerified: over.verified ?? true,
  });
  return id;
}

/** The account a first sign-in with `sub` creates in the new pool (provisioning's own row). */
async function stray(
  t: TestTenant,
  sub: string,
  email: string,
  emailVerified = true
): Promise<string> {
  await expect(
    t.run(() => ensureUserProvisioned(sub, { email, emailVerified }))
  ).resolves.toBe("created");
  return sub;
}

const userRow = async (id: string): Promise<Row | undefined> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "select id, tenant_id, cognito_sub, email, account_status::text as status from users where id = $1::uuid",
        [id]
      )
    )
  ).rows[0];

const relinkAudit = async (accountId: string): Promise<Row[]> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "select details from audit_log where target_id = $1::uuid and details->>'type' = 'identity_relinked'",
        [accountId]
      )
    )
  ).rows;

const planFor = (r: { plans: readonly AccountPlan[] }, email: string) =>
  r.plans.filter((p) => p.email === email);
const only = (r: { plans: readonly AccountPlan[] }) => r.plans[0]!;

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

beforeEach(async () => {
  pool = new FakePool();
  invalidated.length = 0;
  clearConfigCache();
  await clearPermissionsCache();
  resetRateLimiter();
});

dbDescribe("review 15 H1: an account bound in the current pool is never moved", () => {
  it("the reviewer's proof: a later bulk run never moves an already-linked staff account to whoever now holds its stale address", async () => {
    const email = address("stale");
    const id = await staff(a, email);
    const owner = pool.add(email);
    await relinkIdentities(request({ email, apply: true }), deps());
    await expect(a.run(() => resolveAccount(owner.sub))).resolves.toEqual({
      kind: "bound",
      accountId: id,
    });
    // The owner changes their address in the pool; users.email is never updated.
    (owner as { email: string }).email = address("new-address");
    // Someone else now verifies the old address in the pool and signs in once (a stray).
    const other = pool.add(email);
    await stray(a, other.sub, email);
    // The routine bulk re-run picking up stragglers — with every permissive flag.
    const report = await relinkIdentities(
      request({
        scope: "all-staff",
        tenantId: a.id,
        mergeStrays: true,
        skipAmbiguous: true,
        apply: true,
      }),
      deps()
    );
    expect(planFor(report, email)).toEqual([
      expect.objectContaining({ status: "refused", code: "account.bound_in_pool" }),
    ]);
    // The owner's current subject was asked of the pool.
    expect(pool.askedSubs).toContain(owner.sub);
    // Nothing moved: the owner keeps the account and its role; the stranger has only the stray.
    await expect(a.run(() => resolveAccount(owner.sub))).resolves.toEqual({
      kind: "bound",
      accountId: id,
    });
    await expect(a.run(() => resolveAccount(other.sub))).resolves.toEqual({
      kind: "bound",
      accountId: other.sub,
    });
    expect(await a.run(() => resolvePermissions(other.sub))).not.toMatchObject({
      roleName: "super_admin",
    });
    expect(await userRow(other.sub)).toBeDefined();
    expect(await relinkAudit(id)).toHaveLength(1);
  });

  it("the owner gone from the pool too: refused all the same — it was re-linked in this pool (its record)", async () => {
    const email = address("gone");
    const id = await staff(a, email);
    const owner = pool.add(email);
    await relinkIdentities(request({ email, apply: true }), deps());
    pool.remove(owner.sub);
    const other = pool.add(email);
    for (const r of [
      await relinkIdentities(request({ email, apply: true }), deps()),
      await relinkIdentities(
        request({ scope: "all", tenantId: a.id, skipAmbiguous: true, apply: true }),
        deps()
      ),
    ])
      expect(planFor(r, email)).toEqual([
        expect.objectContaining({ code: "account.relinked_in_pool" }),
      ]);
    expect(await userRow(id)).toMatchObject({ cognito_sub: owner.sub });
    void other;
  });

  it("an account made in the new pool (at or after --created-before) is never a target", async () => {
    const email = address("late");
    // A staff account made after the move, bound to its own new-pool identity…
    const late = await staff(a, email, { createdAt: new Date().toISOString() });
    // … and the pool's user for the address is someone else.
    pool.add(email);
    const report = await relinkIdentities(request({ email, apply: true }), deps());
    expect(only(report)).toMatchObject({ status: "refused", code: "account.none" });
    expect((only(report) as { detail: string }).detail).toContain(
      "provisioned at or after --created-before"
    );
    expect(await userRow(late)).toMatchObject({ cognito_sub: late });
    // With the cutoff after it (a dry run), it would have been the target: the cutoff decides.
    const misdated = await relinkIdentities(
      request({ email, createdBefore: new Date(Date.now() + 30_000).toISOString() }),
      deps()
    );
    expect(only(misdated)).toMatchObject({ status: "relink", accountId: late });
  });

  it("an account whose current subject is a user of this pool is never moved, though never re-linked by the command", async () => {
    const email = address("native");
    // Provisioned in the old pool, but its subject also exists in this pool (an imported user).
    const id = await staff(a, email);
    pool.add(address("elsewhere"), { sub: id });
    pool.add(email);
    const report = await relinkIdentities(request({ email }), deps());
    expect(only(report)).toMatchObject({ code: "account.bound_in_pool" });
    expect((only(report) as { detail: string }).detail).toContain("account recovery");
  });

  it("--created-before is required, and a malformed or future time is refused before anything is read", async () => {
    const email = address("cutoff");
    for (const createdBefore of ["", "2026-10-20", "2999-01-01T00:00:00Z"])
      await expect(
        relinkIdentities(request({ email, createdBefore }), deps())
      ).rejects.toThrow("--created-before");
    expect(pool.asked).toEqual([]);
  });
});

dbDescribe(
  "review 15 M1: nobody blocks a re-link by signing up with a staff address",
  () => {
    it("the reviewer's proof: an unconfirmed sign-up with a staff member's address does not block their re-link", async () => {
      const email = address("dos");
      const id = await staff(a, email);
      // What /api/auth/sign-up does for an attacker who never confirms: a row with the typed address.
      const attacker = randomUUID();
      await expect(a.run(() => ensureUserProvisioned(attacker, { email }))).resolves.toBe(
        "created"
      );
      const victim = pool.add(email);
      const report = await relinkIdentities(request({ email, apply: true }), deps());
      expect(only(report)).toMatchObject({ status: "relink", accountId: id });
      expect(await userRow(id)).toMatchObject({ cognito_sub: victim.sub });
      expect(await userRow(attacker)).toMatchObject({ cognito_sub: attacker });
    });

    it("an unverified account made in the OLD pool does not block either; nor a verified one made in the new pool", async () => {
      const email = address("dos2");
      const id = await staff(a, email);
      await staff(a, email, { role: "free", verified: false }); // old pool, never verified
      await stray(a, randomUUID(), email, true); // new pool, verified there
      const victim = pool.add(email);
      const report = await relinkIdentities(request({ email, apply: true }), deps());
      expect(only(report)).toMatchObject({ status: "relink", accountId: id });
      expect(await userRow(id)).toMatchObject({ cognito_sub: victim.sub });
    });

    it("two verified old-pool accounts are still ambiguous: account.many", async () => {
      const email = address("two");
      await staff(a, email);
      await staff(a, email, { role: "free" });
      pool.add(email);
      const report = await relinkIdentities(request({ email }), deps());
      expect(only(report)).toMatchObject({ code: "account.many" });
    });

    it("the reviewer's proof: a sign-up typed with a Kelvin sign (U+212A) is stored as typed — never as the staff address — and does not block", async () => {
      const email = `kadmin.${run}.${++n}@relink15.example`;
      const id = await staff(a, email);
      const spoof = email.replace("kadmin", "Kadmin");
      const spoofer = randomUUID();
      await expect(
        a.run(() => ensureUserProvisioned(spoofer, { email: spoof, emailVerified: true }))
      ).resolves.toBe("created");
      // Stored with the Kelvin sign: toLowerCase() would have made it the staff address.
      expect((await userRow(spoofer))!.email).toBe(spoof);
      const owner = pool.add(email);
      const report = await relinkIdentities(request({ email, apply: true }), deps());
      expect(only(report)).toMatchObject({ status: "relink", accountId: id });
      expect(await userRow(id)).toMatchObject({ cognito_sub: owner.sub });
      // The lookalike itself is refused, never folded (single: before anything is read; bulk: reported).
      await expect(relinkIdentities(request({ email: spoof }), deps())).rejects.toThrow(
        "plain ASCII"
      );
      const bulk = await relinkIdentities(
        request({ scope: "all", tenantId: a.id, skipAmbiguous: true }),
        deps()
      );
      expect(planFor(bulk, spoof)).toEqual([
        expect.objectContaining({ code: "address.unsupported" }),
      ]);
    });

    it("a ban still follows a lookalike of a banned address (folded for the carry-over)", async () => {
      const t = await createTestTenant();
      const email = `kbanned.${run}.${++n}@relink15.example`;
      const banned = await staff(t, email, { role: "free" });
      await withOwnerTx("operator", (tx) =>
        tx.query("update users set account_status = 'banned' where id = $1::uuid", [
          banned,
        ])
      );
      const spoofer = randomUUID();
      await t.run(() =>
        ensureUserProvisioned(spoofer, { email: email.replace("k", "K") })
      );
      expect(await userRow(spoofer)).toMatchObject({ status: "banned" });
    });

    it("TASK-176 / review 16 D4f: the one pre-move account whose own flag says unverified is re-linked only on the operator's confirmation for it — and the record says so", async () => {
      const email = address("unverified");
      const id = await staff(a, email, { verified: false });
      const g = pool.add(email);
      const refused = await relinkIdentities(request({ email, apply: true }), deps());
      expect(only(refused)).toMatchObject({
        status: "refused",
        code: "account.needs_confirmation",
        needsConfirmation: { accountId: id, tenantId: a.id, role: "super_admin" },
      });
      expect(await userRow(id)).toMatchObject({ cognito_sub: id });
      const done = await relinkIdentities(
        request({ email, apply: true, confirmUnverified: [id] }),
        deps()
      );
      expect(only(done)).toMatchObject({
        status: "relink",
        accountId: id,
        accountUnverified: true,
        unverifiedConfirmed: true,
      });
      expect(only(done)).not.toHaveProperty("unverifiedAccepted");
      expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
      expect((await relinkAudit(id))[0]!.details).toMatchObject({
        accountUnverified: true,
        unverifiedConfirmed: true,
      });

      // Bulk too: refused and listed, then confirmed per account.
      const t = await createTestTenant();
      const e2 = address("unverified-bulk");
      const id2 = await staff(t, e2, { verified: false });
      const g2 = pool.add(e2);
      const listed = await relinkIdentities(
        request({ scope: "all-staff", tenantId: t.id, apply: true }),
        deps()
      );
      expect(listed).toMatchObject({ applied: false, stoppedBy: "refusal" });
      expect(only(listed)).toMatchObject({ code: "account.needs_confirmation" });
      const bulk = await relinkIdentities(
        request({
          scope: "all-staff",
          tenantId: t.id,
          apply: true,
          confirmUnverified: [id2.toUpperCase()],
        }),
        deps()
      );
      expect(bulk.applied).toBe(true);
      expect(await userRow(id2)).toMatchObject({ cognito_sub: g2.sub });
    });

    it("TASK-176: the pool must still have verified the address — an unverified pool user is refused whatever the account", async () => {
      const email = address("pool-unverified");
      const id = await staff(a, email, { verified: false });
      pool.add(email, { emailVerified: false });
      const report = await relinkIdentities(request({ email, apply: true }), deps());
      expect(only(report)).toMatchObject({ code: "pool.unverified" });
      expect(await userRow(id)).toMatchObject({ cognito_sub: id });
    });

    it("TASK-176 M1: a post-move unverified sign-up with the address neither blocks the unverified pre-move account nor is chosen", async () => {
      const email = address("unverified-dos");
      const id = await staff(a, email, { verified: false });
      // An attacker's sign-up after the move: provisioned unverified, never confirmed.
      const attacker = randomUUID();
      await expect(a.run(() => ensureUserProvisioned(attacker, { email }))).resolves.toBe(
        "created"
      );
      const victim = pool.add(email);
      // Naming it is refused too: it is not a pre-move account.
      const named = await relinkIdentities(
        request({ email, unverifiedAccount: attacker }),
        deps()
      );
      expect(only(named)).toMatchObject({ code: "account.unverified" });
      const report = await relinkIdentities(
        request({ email, apply: true, confirmUnverified: [id] }),
        deps()
      );
      expect(only(report)).toMatchObject({
        status: "relink",
        accountId: id,
        accountUnverified: true,
      });
      expect(await userRow(id)).toMatchObject({ cognito_sub: victim.sub });
      expect(await userRow(attacker)).toMatchObject({ cognito_sub: attacker });
    });

    it("several pre-move accounts, none verified: account.many with their ids offered; --unverified-account names the person's, recorded; a wrong id is refused", async () => {
      const email = address("unverified-many");
      const id = await staff(a, email, { verified: false });
      const other = await staff(a, email, { role: "free", verified: false });
      const g = pool.add(email);
      const offered = await relinkIdentities(request({ email, apply: true }), deps());
      expect(only(offered)).toMatchObject({ code: "account.many" });
      expect(
        (
          only(offered) as { unverifiedCandidates?: string[] }
        ).unverifiedCandidates?.sort()
      ).toEqual([id, other].sort());
      expect(await userRow(id)).toMatchObject({ cognito_sub: id });
      const wrong = await relinkIdentities(
        request({ email, unverifiedAccount: randomUUID() }),
        deps()
      );
      expect(only(wrong)).toMatchObject({ code: "account.unverified" });
      const done = await relinkIdentities(
        request({ email, unverifiedAccount: id, apply: true }),
        deps()
      );
      expect(only(done)).toMatchObject({
        status: "relink",
        accountId: id,
        unverifiedAccepted: true,
      });
      expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
      expect(await userRow(other)).toMatchObject({ cognito_sub: other });
      expect((await relinkAudit(id))[0]!.details).toMatchObject({
        unverifiedAccepted: true,
        accountUnverified: true,
      });
    });

    it("one verified pre-move account beside an unverified one is still the target (the flag breaks the tie)", async () => {
      const email = address("tie");
      const id = await staff(a, email);
      await staff(a, email, { role: "free", verified: false });
      pool.add(email);
      const report = await relinkIdentities(request({ email }), deps());
      expect(only(report)).toMatchObject({ status: "relink", accountId: id });
      expect(only(report)).not.toHaveProperty("accountUnverified");
    });
  }
);

dbDescribe("review 15 M2: a cache failure after the commit", () => {
  it("the reviewer's proof (review 16 M2: the strict publish): reported 'Applied' with a warning naming each subject not voided and why (exit 5) — never 'Nothing was changed', never 'on every instance'", async () => {
    const { closeCache } = await import("@/platform/cache");
    const email = address("lie");
    const id = await staff(a, email);
    const g = pool.add(email);
    await closeCache();
    const saved = {
      p: process.env.CACHE_PROVIDER,
      u: process.env.UPSTASH_REDIS_REST_URL,
      t: process.env.UPSTASH_REDIS_REST_TOKEN,
    };
    process.env.CACHE_PROVIDER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const out: string[] = [];
    let code: number;
    try {
      code = await runRelinkCommand(
        [
          "--email",
          email,
          "--created-before",
          movedAt(),
          "--operator",
          "op",
          "--reason",
          "pool moved",
          "--apply",
        ],
        {
          ...process.env,
          DATABASE_OWNER_URL: "postgresql://owner:pw@localhost:5432/replay",
          DATABASE_SSL: "disable",
        },
        { out: (l) => out.push(l), err: (l) => out.push(l) },
        { directory: pool, machine: { osUser: "o", host: "h" } }
      );
    } finally {
      for (const [k, v] of [
        ["CACHE_PROVIDER", saved.p],
        ["UPSTASH_REDIS_REST_URL", saved.u],
        ["UPSTASH_REDIS_REST_TOKEN", saved.t],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      await closeCache();
    }
    const text = out.join("\n");
    expect(code).toBe(EXIT.appliedNotVoided);
    expect(text).toContain("Applied — pool us-east-1_NewPool15");
    expect(text).toContain("Not voided for 2 subject(s)");
    expect(text).toContain("not published");
    expect(text).not.toContain("on every instance");
    expect(text).toContain("at most 60 s more");
    expect(text).toContain("The change itself is committed.");
    expect(text).not.toContain("Nothing was changed");
    expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
  });

  it("an invalidation that throws is reported per subject; the change stands", async () => {
    const email = address("throws");
    const id = await staff(a, email);
    const g = pool.add(email);
    const report = await relinkIdentities(
      request({ email, apply: true }),
      deps({
        invalidate: async (s: string) => {
          if (s === g.sub) throw new Error("cache down");
          invalidated.push(s);
        },
      })
    );
    expect(report.applied).toBe(true);
    expect(report.invalidated).toEqual([id]);
    expect(report.notInvalidated).toEqual([{ subject: g.sub, error: "cache down" }]);
    expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
  });
});

dbDescribe("review 15 M3: one identity, two accounts", () => {
  it("the reviewer's proof: bulk --all across tenants never plans two accounts onto one subject — both refused; --skip-ambiguous applies the rest, no unique violation", async () => {
    // Its own two tenants (review 16 L9): the cross-tenant run never reaches the shared
    // database's other tenants (RelinkDeps.onlyTenants).
    const ta = await createTestTenant();
    const tb = await createTestTenant();
    const scoped = (over: Record<string, unknown> = {}) =>
      deps({ onlyTenants: [ta.id, tb.id], ...over });
    const email = address("twotenants");
    const idA = await staff(ta, email);
    const idB = await staff(tb, email);
    const fine = address("fine");
    const idFine = await staff(ta, fine);
    const gFine = pool.add(fine);
    pool.add(email);
    const dry = await relinkIdentities(
      request({ scope: "all-staff", skipAmbiguous: true }),
      scoped()
    );
    // Only its own tenants' addresses were planned.
    expect(new Set(dry.plans.map((p) => p.email))).toEqual(new Set([email, fine]));
    expect(planFor(dry, email).map((x) => (x as { code?: string }).code)).toEqual([
      "subject.contested",
      "subject.contested",
    ]);
    const stopped = await relinkIdentities(
      request({ scope: "all-staff", apply: true }),
      scoped()
    );
    expect(stopped).toMatchObject({ applied: false, stoppedBy: "refusal" });
    const applied = await relinkIdentities(
      request({ scope: "all-staff", skipAmbiguous: true, apply: true }),
      scoped()
    );
    expect(applied.plans).toHaveLength(3);
    expect(applied.applied).toBe(true);
    expect(await userRow(idFine)).toMatchObject({ cognito_sub: gFine.sub });
    expect(await userRow(idA)).toMatchObject({ cognito_sub: idA });
    expect(await userRow(idB)).toMatchObject({ cognito_sub: idB });
    // Named by tenant, one of them is re-linked.
    const one = await relinkIdentities(
      request({ email, tenantId: ta.id, apply: true }),
      scoped()
    );
    expect(only(one)).toMatchObject({ status: "relink", accountId: idA });
  });
});

dbDescribe("review 15 M4: applied in chunks", () => {
  async function fiveStaff() {
    const t = await createTestTenant();
    const out: { id: string; g: DirectoryUser }[] = [];
    for (let i = 0; i < 5; i++) {
      const email = address(`chunk${i}`);
      out.push({ id: await staff(t, email), g: pool.add(email) });
    }
    return { t, out };
  }

  it("each chunk its own transaction; the report says which applied", async () => {
    const { t, out } = await fiveStaff();
    const report = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id, apply: true }),
      deps({ chunkSize: 2 })
    );
    expect(report.chunks.map((c) => [c.from, c.to, c.outcome, c.relinked])).toEqual([
      [0, 2, "applied", 2],
      [2, 4, "applied", 2],
      [4, 5, "applied", 1],
    ]);
    for (const { id, g } of out)
      expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
    const runs = new Set(
      (
        await Promise.all(out.map(async ({ id }) => (await relinkAudit(id))[0]!.details))
      ).map((d) => (d as { runId: string }).runId)
    );
    expect(runs).toEqual(new Set([report.runId]));
  });

  it("a failure after a chunk committed: that chunk stands, the failed one changed nothing, the rest did not run; a rerun completes it", async () => {
    const { t, out } = await fiveStaff();
    const report = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id, apply: true }),
      deps({
        chunkSize: 2,
        onChunk: async (index: number) => {
          if (index === 1) throw new Error("connection terminated unexpectedly");
        },
      })
    );
    expect(report).toMatchObject({
      applied: true,
      stoppedBy: "failure",
      failure: { chunk: 1, message: "connection terminated unexpectedly" },
    });
    expect(report.chunks.map((c) => c.outcome)).toEqual(["applied", "failed", "not-run"]);
    const subs = await Promise.all(
      out.map(async ({ id }) => (await userRow(id))!.cognito_sub)
    );
    expect(subs).toEqual([
      out[0]!.g.sub,
      out[1]!.g.sub,
      out[2]!.id,
      out[3]!.id,
      out[4]!.id,
    ]);
    // The first chunk's subjects were voided after its commit.
    expect(new Set(report.invalidated)).toEqual(
      new Set([out[0]!.id, out[0]!.g.sub, out[1]!.id, out[1]!.g.sub])
    );
    const again = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id, apply: true }),
      deps({ chunkSize: 2 })
    );
    expect(again.plans.map((p) => p.status)).toEqual([
      "linked",
      "linked",
      "relink",
      "relink",
      "relink",
    ]);
    for (const { id, g } of out)
      expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
    for (const { id } of out) expect(await relinkAudit(id)).toHaveLength(1);
  });

  it("a failure in the first chunk: nothing committed — thrown, as before (exit 3)", async () => {
    const { t, out } = await fiveStaff();
    await expect(
      relinkIdentities(
        request({ scope: "all-staff", tenantId: t.id, apply: true }),
        deps({
          chunkSize: 2,
          onChunk: async () => {
            throw new Error("connection terminated unexpectedly");
          },
        })
      )
    ).rejects.toThrow("connection terminated");
    for (const { id } of out)
      expect(await userRow(id)).toMatchObject({ cognito_sub: id });
  });

  it("an address that changed since the preview is refused under lock; without --skip-ambiguous its chunk changes nothing", async () => {
    const { t, out } = await fiveStaff();
    const report = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id, apply: true }),
      deps({
        chunkSize: 2,
        directory: Object.assign(Object.create(pool), {
          poolId: pool.poolId,
          // The third account's subject changes between the preview and its chunk's lock.
          findBySub: async (s: string) => {
            if (s === out[2]!.id)
              await withOwnerTx("operator", (tx) =>
                tx.query("update users set cognito_sub = $2 where id = $1::uuid", [
                  out[2]!.id,
                  randomUUID(),
                ])
              );
            return pool.findBySub(s);
          },
        }),
      })
    );
    expect(report.stoppedBy).toBe("refusal");
    expect(report.applied).toBe(false);
    expect(planFor(report, report.plans[2]!.email)).toEqual([
      expect.objectContaining({ code: "account.changed" }),
    ]);
    for (const i of [0, 1, 3, 4])
      expect(await userRow(out[i]!.id)).toMatchObject({ cognito_sub: out[i]!.id });
  });
});

dbDescribe("review 15 L3, L6, L7", () => {
  it("the reviewer's proof (L3): after a re-link the old subject's sign-in events record no actor — not the account it no longer names", async () => {
    const email = address("conflict");
    const id = await staff(a, email);
    pool.add(email);
    await relinkIdentities(request({ email, apply: true }), deps());
    await expect(a.run(() => resolveAccount(id))).resolves.toEqual({ kind: "conflict" });
    await expect(a.run(() => auditableAccountId(id))).resolves.toBeUndefined();
  });

  it("L6: bulk asks the pool for an address as it is stored, not only in lower case", async () => {
    const t = await createTestTenant();
    const stored = `Mixed.Case.${run}.${++n}@Relink15.Example`;
    const id = await staff(t, stored);
    // The pool holds it exactly as the account does (ListUsers is case-sensitive).
    const g = pool.add(stored);
    const report = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id, apply: true }),
      deps()
    );
    expect(pool.asked).toEqual([stored.toLowerCase(), stored]);
    expect(only(report)).toMatchObject({ status: "relink", accountId: id });
    expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
  });

  it("L7: a stray that gains data meanwhile in a table with no foreign key to users is not merged — counted again after the delete", async () => {
    const email = address("gains");
    const id = await staff(a, email);
    const g = pool.add(email);
    const strayId = await stray(a, g.sub, email);
    const gain = (
      index: number,
      tx: { query: (sql: string, p: unknown[]) => Promise<unknown> }
    ) =>
      index === 0
        ? tx.query(
            "insert into user_ai_context (user_id, tenant_id) values ($1, $2::uuid)",
            [strayId, a.id]
          )
        : Promise.resolve();
    const report = await relinkIdentities(
      request({ email, mergeFrom: strayId, apply: true }),
      deps({ onChunk: gain })
    );
    expect(report).toMatchObject({ applied: false, stoppedBy: "refusal" });
    expect(only(report)).toMatchObject({ code: "merge.unsafe" });
    expect((only(report) as { detail: string }).detail).toContain(
      "gained data meanwhile"
    );
    // Nothing changed: the stray is still there, the account still on its old subject.
    expect(await userRow(strayId)).toMatchObject({ cognito_sub: g.sub });
    expect(await userRow(id)).toMatchObject({ cognito_sub: id });
    expect(await relinkAudit(id)).toEqual([]);
    // Without the gain, the merge goes through.
    const merged = await relinkIdentities(
      request({ email, mergeFrom: strayId, apply: true }),
      deps()
    );
    expect(merged.applied).toBe(true);
    expect(await userRow(strayId)).toBeUndefined();
    expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
  });
});
