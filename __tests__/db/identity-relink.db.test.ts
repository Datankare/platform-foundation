/**
 * @jest-environment node
 */
/**
 * Re-linking existing accounts to their identity in a new user pool (TASK-174, ADR-012
 * amendment), against the replayed Postgres. The pool is a fake (IdentityDirectory); everything
 * else is the platform's own: the plan and its one owner transaction, the audit record, and —
 * afterwards — a sign-in with the new subject through permissions, the admin guard, the identity's
 * tenant, provisioning, the account guard, export, erasure and the guest route.
 *
 * The situation it repairs: staff accounts whose users.cognito_sub (and id) is the old pool's
 * subject. A sign-in with the new pool's subject must reach the staff account with its role —
 * never a second, ordinary account — and no row is ever changed by hand.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-relink",
}));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { withOwnerTx } from "@/platform/data";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import type { AuthProvider } from "@/platform/auth/provider";
import type { TokenPayload } from "@/platform/auth/types";
import { clearConfigCache } from "@/platform/auth/platform-config";
import { resolvePermissions } from "@/platform/auth/permissions";
import {
  clearPermissionsCache,
  getCachedPermissions,
  invalidatePermissions,
} from "@/platform/auth/permissions-cache";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { requireActor } from "@/platform/auth/middleware";
import { requireActorWithStatus } from "@/platform/auth/actor-guard";
import { auditableAccountId, resolveAccount } from "@/platform/auth/account-identity";
import {
  ensureUserProvisioned,
  provisionAccount,
} from "@/platform/auth/user-provisioning";
import { hardPurgeUser, softDeleteUser } from "@/platform/auth/gdpr-deletion";
import { ensureIdentityTenant } from "@/platform/tenancy/identity";
import { runRequestScope, runWithTenant } from "@/platform/tenancy/context";
import { GET as exportGET } from "@/app/api/account/export/route";
import { POST as guestPOST } from "@/app/api/auth/guest/route";
import type {
  DirectoryUser,
  IdentityDirectory,
} from "@/platform/auth/identity-directory";
import {
  relinkIdentities,
  subjectHint,
  type AccountPlan,
  type RelinkRequest,
} from "@/platform/auth/identity-relink";
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
  readonly poolId = "us-east-1_NewPool01";
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
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

let a: TestTenant;
let b: TestTenant;
let pool: FakePool;
const invalidated: string[] = [];
const run = randomUUID().slice(0, 8);
let n = 0;
/** A fresh address for each test (single runs search every tenant). */
const address = (label: string) => `${label}.${run}.${++n}@relink.example`;

const deps = () => ({
  directory: pool,
  invalidate: async (s: string) => {
    invalidated.push(s);
    await invalidatePermissions(s);
  },
});

/** When the deployment moved to the new pool: an hour ago (staff accounts are older; strays newer). */
const movedAt = () => new Date(Date.now() - 3_600_000).toISOString();

const request = (over: Partial<RelinkRequest>): RelinkRequest => ({
  apply: false,
  createdBefore: movedAt(),
  operator: "Raman (owner)",
  osUser: "raman",
  host: "trusted-mac",
  reason: "dev/staging pool replaced (old pool deleted with the AWS account)",
  ...over,
});

/**
 * A staff account of `t` with the old pool's subject as its id and subject: made in the old pool
 * (a day ago, before the move), its address verified there.
 */
async function staff(
  t: TestTenant,
  email: string,
  role = "super_admin"
): Promise<string> {
  const id = randomUUID();
  await insertUser(t, {
    id,
    cognitoSub: id,
    email,
    roleId: await seededRoleId(role),
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    emailVerified: true,
  });
  // An adult whose age is verified, as staff are: the age-and-consent gate lets them through.
  await withOwnerTx("operator", (tx) =>
    tx.query(
      "update users set date_of_birth = '1980-01-01', age_verified = true, age_verified_at = now() where id = $1::uuid",
      [id]
    )
  );
  return id;
}

/** The stray account a first sign-in with `sub` creates (provisioning's own row). */
async function stray(t: TestTenant, sub: string, email: string): Promise<string> {
  const outcome = await t.run(() =>
    ensureUserProvisioned(sub, { email, emailVerified: true })
  );
  expect(outcome).toBe("created");
  return sub;
}

const userRow = async (id: string): Promise<Row | undefined> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "select id, tenant_id, cognito_sub, email, role_id, account_status::text as status, deleted_at, updated_at from users where id = $1::uuid",
        [id]
      )
    )
  ).rows[0];

const rowsWithSubject = async (sub: string): Promise<Row[]> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "select id, cognito_sub from users where cognito_sub = $1 or id = $2::uuid",
        [sub, sub]
      )
    )
  ).rows;

const relinkAudit = async (accountId: string): Promise<Row[]> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "select tenant_id, actor_id, target_id, details from audit_log where target_id = $1::uuid and details->>'type' = 'identity_relinked'",
        [accountId]
      )
    )
  ).rows;

const plan = (r: { plans: readonly AccountPlan[] }, i = 0) => r.plans[i]!;

// ── A provider for the sign-ins afterwards ──────────────────────────────────────────────────

let tokens = new Map<string, TokenPayload>();
const tenantsAssigned = new Map<string, string>();
function signInAs(sub: string, over: Partial<TokenPayload> = {}): string {
  const token = `tok-${randomUUID()}`;
  tokens.set(token, {
    sub,
    email: "",
    emailVerified: true,
    iat: 0,
    exp: Math.floor(Date.now() / 1000) + 600,
    mfaEnabled: true,
    ...over,
  });
  return token;
}
const httpRequest = (path: string, token: string, method = "GET") =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.7" },
  });

const saved = { mode: process.env.TENANCY_MODE, tenant: process.env.TENANT_ID };
/**
 * Run as one request of a single-tenant deployment of `t`: a request scope (as tenantRoute gives
 * every route), whose tenant the verifier binds from the identity.
 */
async function asSingle<T>(t: TestTenant, fn: () => Promise<T>): Promise<T> {
  delete process.env.TENANCY_MODE;
  process.env.TENANT_ID = t.id;
  try {
    return await runRequestScope(fn);
  } finally {
    if (saved.mode === undefined) delete process.env.TENANCY_MODE;
    else process.env.TENANCY_MODE = saved.mode;
    if (saved.tenant === undefined) delete process.env.TENANT_ID;
    else process.env.TENANT_ID = saved.tenant;
  }
}

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    const base = createMockAuthProvider();
    const provider: AuthProvider = {
      ...base,
      verifyToken: async (t: string) => tokens.get(t) ?? null,
      assignTenant: async (u: string, t: string) => {
        tenantsAssigned.set(u, t);
        return { success: true };
      },
      getUserTenant: async (u: string) => tenantsAssigned.get(u) ?? null,
      deleteUser: async () => ({ success: true }),
    };
    registerAuthProvider(provider);
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

beforeEach(async () => {
  pool = new FakePool();
  invalidated.length = 0;
  tokens = new Map();
  tenantsAssigned.clear();
  clearConfigCache();
  await clearPermissionsCache();
  resetRateLimiter();
});

dbDescribe("re-linking an account to its identity in a new pool (Postgres)", () => {
  it("a dry run prints the plan and changes nothing", async () => {
    const email = address("dry");
    const id = await staff(a, email);
    const g = pool.add(email, { providers: ["Google"], status: "EXTERNAL_PROVIDER" });
    const before = await userRow(id);
    const report = await relinkIdentities(request({ email }), deps());
    expect(report.applied).toBe(false);
    expect(plan(report)).toMatchObject({
      status: "relink",
      accountId: id,
      tenantId: a.id,
      role: "super_admin",
      previousSubject: id,
      newSubject: g.sub,
      signsInWith: ["Google"],
    });
    expect(await userRow(id)).toEqual(before);
    expect(await relinkAudit(id)).toEqual([]);
    expect(invalidated).toEqual([]);
    expect(await rowsWithSubject(g.sub)).toEqual([]);
  });

  it("applied: the subject changes, the id stays; one audit record with the operator, the reason and hashed subjects; both subjects voided", async () => {
    const email = address("apply");
    const id = await staff(a, email);
    const g = pool.add(email);
    const report = await relinkIdentities(request({ email, apply: true }), deps());
    expect(report.applied).toBe(true);
    expect(await userRow(id)).toMatchObject({
      id,
      cognito_sub: g.sub,
      tenant_id: a.id,
    });
    const audit = await relinkAudit(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenant_id: a.id, actor_id: null, target_id: id });
    expect(audit[0]!.details).toMatchObject({
      type: "identity_relinked",
      agent: "operator:relink-identity",
      operator: "Raman (owner)",
      osUser: "raman",
      host: "trusted-mac",
      reason: "dev/staging pool replaced (old pool deleted with the AWS account)",
      pool: "us-east-1_NewPool01",
      mode: "single",
      runId: report.runId,
      previousSubject: subjectHint(id),
      newSubject: subjectHint(g.sub),
      outcome: "succeeded",
    });
    // Never a whole subject in the record.
    const text = JSON.stringify(audit[0]!.details);
    expect(text).not.toContain(g.sub);
    expect(text).not.toContain(id);
    expect(invalidated.sort()).toEqual([id, g.sub].sort());
  });

  it("afterwards a sign-in with the new subject is the staff account: permissions, admin guard, account guard, provisioning — no second row", async () => {
    const email = address("signin");
    const id = await staff(a, email);
    const g = pool.add(email);
    await relinkIdentities(request({ email, apply: true }), deps());

    await expect(a.run(() => resolveAccount(g.sub))).resolves.toEqual({
      kind: "bound",
      accountId: id,
    });
    // Sign-in, sign-out and MFA events are recorded under the account, not the new subject.
    await expect(a.run(() => auditableAccountId(g.sub))).resolves.toBe(id);
    const perms = await a.run(() => resolvePermissions(g.sub));
    expect(perms).toMatchObject({ userId: id, roleName: "super_admin" });
    expect(perms!.permissions.length).toBeGreaterThan(0);

    // Provisioning recognises the account by its subject: existing, and the account's id.
    await expect(a.run(() => ensureUserProvisioned(g.sub, { email }))).resolves.toBe(
      "existing"
    );
    await expect(a.run(() => provisionAccount(g.sub, { email }))).resolves.toEqual({
      outcome: "existing",
      accountId: id,
    });
    expect(await rowsWithSubject(g.sub)).toEqual([{ id, cognito_sub: g.sub }]);

    await asSingle(a, async () => {
      const token = signInAs(g.sub, { email });
      const admin = await requireAdmin(
        httpRequest("/api/admin/config", token),
        perms!.permissions.find(
          (p) => p.startsWith("admin_") || p === "can_access_admin"
        )!
      );
      expect(admin.error).toBeUndefined();
      expect(admin.admin).toMatchObject({
        userId: id,
        sub: g.sub,
        roleName: "super_admin",
      });

      const actor = await requireActor(httpRequest("/api/x", token), {
        allowGuests: false,
      });
      expect(actor.actor).toMatchObject({ kind: "user", id, tenantId: a.id });
      const guarded = await requireActorWithStatus(
        httpRequest("/api/x", token),
        "translate",
        { allowGuests: false }
      );
      expect(guarded.error).toBeUndefined();
      expect(guarded.actor).toMatchObject({ kind: "user", id });
    });
    expect(await rowsWithSubject(g.sub)).toEqual([{ id, cognito_sub: g.sub }]);
  });

  it("afterwards the identity's tenant is the account's (shared): assigned at its tenant, refused at another", async () => {
    const email = address("tenant");
    const id = await staff(a, email);
    const g = pool.add(email);
    await relinkIdentities(request({ email, apply: true }), deps());
    expect(id).not.toBe(g.sub);
    const token = signInAs(g.sub);
    await expect(
      runWithTenant({ tenantId: b.id, mode: "shared" }, () => ensureIdentityTenant(token))
    ).resolves.toEqual({ ok: false, code: "tenant.mismatch" });
    expect(tenantsAssigned.get(g.sub)).toBeUndefined();
    await expect(
      runWithTenant({ tenantId: a.id, mode: "shared" }, () => ensureIdentityTenant(token))
    ).resolves.toEqual({ ok: true });
    expect(tenantsAssigned.get(g.sub)).toBe(a.id);
  });

  it("afterwards export and erasure are the account's: the export route returns it; erased, the new subject is never provisioned again", async () => {
    const email = address("gdpr");
    const id = await staff(a, email, "free");
    const g = pool.add(email);
    await relinkIdentities(request({ email, apply: true }), deps());

    await asSingle(a, async () => {
      const res = await exportGET(httpRequest("/api/account/export", signInAs(g.sub)));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profile: Row; auditLog: Row[] };
      expect(body.profile).toMatchObject({ id });
      // The re-link is in the account's own trail (who did it is not given to the user).
      expect(JSON.stringify(body.auditLog)).toContain("identity_relinked");
    });

    const erased = await a.run(() => softDeleteUser(id, id));
    expect(erased).toEqual({ success: true, errors: [] });
    const recorded = await withOwnerTx("operator", (tx) =>
      tx.query(
        "select user_id, cognito_sub from user_deletions where user_id = $1::uuid",
        [id]
      )
    );
    expect(recorded.rows).toEqual([{ user_id: id, cognito_sub: g.sub }]);
    await expect(a.run(() => ensureUserProvisioned(g.sub))).resolves.toBe("existing");
    await a.run(() => hardPurgeUser(id));
    expect(await userRow(id)).toBeUndefined();
    // The row is gone; the record still names the identity: no fresh account for it.
    await expect(a.run(() => ensureUserProvisioned(g.sub, { email }))).resolves.toBe(
      "erased"
    );
    expect(await rowsWithSubject(g.sub)).toEqual([]);
    // And a re-link to it is refused.
    const other = await staff(a, address("gdpr-other"));
    pool.add((await userRow(other))!.email as string, { sub: g.sub });
    const again = await relinkIdentities(
      request({ email: (await userRow(other))!.email as string }),
      deps()
    );
    expect(plan(again)).toMatchObject({ status: "refused", code: "subject.erased" });
  });
});

dbDescribe("re-linking refuses every ambiguity, changing nothing (Postgres)", () => {
  it("run again: linked — nothing changed, no second record", async () => {
    const email = address("again");
    const id = await staff(a, email);
    pool.add(email);
    await relinkIdentities(request({ email, apply: true }), deps());
    const after = await userRow(id);
    const report = await relinkIdentities(request({ email, apply: true }), deps());
    expect(plan(report)).toEqual({
      status: "linked",
      email,
      tenantId: a.id,
      accountId: id,
    });
    expect(await userRow(id)).toEqual(after);
    expect(await relinkAudit(id)).toHaveLength(1);
  });

  it.each([
    ["the address is unverified", { emailVerified: false }, "pool.unverified"],
    [
      "a Google user without the verified claim mapped",
      { emailVerified: false, providers: ["Google"], status: "EXTERNAL_PROVIDER" },
      "pool.unverified",
    ],
    ["the pool user is disabled", { enabled: false }, "pool.disabled"],
    ["the pool user never confirmed", { status: "UNCONFIRMED" }, "pool.unconfirmed"],
  ])("refused, nothing changed: %s", async (_label, over, code) => {
    const email = address("refused");
    const id = await staff(a, email);
    pool.add(email, over as Partial<DirectoryUser>);
    const before = await userRow(id);
    const report = await relinkIdentities(request({ email, apply: true }), deps());
    expect(report).toMatchObject({ applied: false, stoppedBy: "refusal" });
    expect(plan(report)).toMatchObject({ status: "refused", code });
    expect(await userRow(id)).toEqual(before);
    expect(await relinkAudit(id)).toEqual([]);
    expect(invalidated).toEqual([]);
  });

  it("refused: two users of the pool have the address", async () => {
    const email = address("two-pool");
    const id = await staff(a, email);
    pool.add(email);
    pool.add(email, { providers: ["Google"], status: "EXTERNAL_PROVIDER" });
    const report = await relinkIdentities(request({ email, apply: true }), deps());
    expect(plan(report)).toMatchObject({ status: "refused", code: "pool.many" });
    expect((await userRow(id))!.cognito_sub).toBe(id);
  });

  it("refused: none of the pool's users has it", async () => {
    const email = address("none");
    await staff(a, email);
    const report = await relinkIdentities(request({ email }), deps());
    expect(plan(report)).toMatchObject({ status: "refused", code: "pool.none" });
  });

  it("refused: two live accounts of the tenant have the address; across tenants, --tenant decides", async () => {
    const email = address("two-accounts");
    const first = await staff(a, email);
    const second = await staff(a, email, "free");
    pool.add(email);
    const same = await relinkIdentities(request({ email, apply: true }), deps());
    expect(plan(same)).toMatchObject({ status: "refused", code: "account.many" });
    expect((await userRow(first))!.cognito_sub).toBe(first);
    expect((await userRow(second))!.cognito_sub).toBe(second);

    const spread = address("spread");
    const inA = await staff(a, spread);
    const inB = await staff(b, spread);
    pool.add(spread);
    const without = await relinkIdentities(request({ email: spread }), deps());
    expect(plan(without)).toMatchObject({ status: "refused", code: "account.many" });
    expect((plan(without) as { detail: string }).detail).toContain("--tenant");
    const named = await relinkIdentities(
      request({ email: spread, tenantId: b.id, apply: true }),
      deps()
    );
    expect(plan(named)).toMatchObject({
      status: "relink",
      accountId: inB,
      tenantId: b.id,
    });
    expect((await userRow(inA))!.cognito_sub).toBe(inA);
  });

  it("refused: no live account has the address (an erased one does not count)", async () => {
    const email = address("gone");
    await insertUser(a, {
      email,
      roleId: await seededRoleId("admin"),
      deletedAt: new Date().toISOString(),
    });
    pool.add(email);
    const report = await relinkIdentities(request({ email }), deps());
    expect(plan(report)).toMatchObject({ status: "refused", code: "account.none" });
  });

  it("the new subject already has a stray account: refused with the merge offered; --merge-from merges it in one transaction", async () => {
    const email = address("stray");
    const id = await staff(a, email);
    const g = pool.add(email, { providers: ["Google"], status: "EXTERNAL_PROVIDER" });
    const strayId = await stray(a, g.sub, email);
    // The stray signed in: its permissions are cached (the default role's).
    expect((await a.run(() => getCachedPermissions(g.sub)))!.roleName).toBe("free");

    const offered = await relinkIdentities(request({ email, apply: true }), deps());
    expect(plan(offered)).toMatchObject({
      status: "refused",
      code: "subject.held",
      mergeCandidate: strayId,
    });
    expect((plan(offered) as { detail: string }).detail).toContain(
      `--merge-from ${strayId}`
    );
    expect((await userRow(id))!.cognito_sub).toBe(id);

    const wrong = await relinkIdentities(
      request({ email, mergeFrom: randomUUID(), apply: true }),
      deps()
    );
    expect(plan(wrong)).toMatchObject({ status: "refused", code: "merge.mismatch" });

    const merged = await relinkIdentities(
      request({ email, mergeFrom: strayId, apply: true }),
      deps()
    );
    expect(plan(merged)).toMatchObject({
      status: "relink",
      merge: { accountId: strayId },
    });
    expect(await rowsWithSubject(g.sub)).toEqual([{ id, cognito_sub: g.sub }]);
    expect(await userRow(strayId)).toBeUndefined();
    const audit = await relinkAudit(id);
    expect(audit[0]!.details).toMatchObject({ mergedAccount: subjectHint(strayId) });
    // The stray's own records stay: the record of its sign-in.
    const kept = await withOwnerTx("operator", (tx) =>
      tx.query(
        "select count(*)::int as n from audit_log where target_id = $1::uuid and action = 'account_created'",
        [strayId]
      )
    );
    expect(kept.rows[0]!.n).toBeGreaterThan(0);
    // Voided: the next check reads the staff account at once.
    expect(await a.run(() => getCachedPermissions(g.sub))).toMatchObject({
      userId: id,
      roleName: "super_admin",
    });
    await expect(a.run(() => ensureUserProvisioned(g.sub))).resolves.toBe("existing");
  });
});

dbDescribe("re-linking against hostile input (Postgres)", () => {
  it("a stray that holds the person's data, or is not a plain first sign-in, is never merged", async () => {
    const cases: [string, (strayId: string) => Promise<unknown>][] = [
      [
        "it holds a consent record",
        (s) =>
          withOwnerTx("operator", (tx) =>
            tx.query(
              "insert into consent_records (user_id, tenant_id, consent_type, consent_version, granted) values ($1::uuid, $2::uuid, 'terms', '1', true)",
              [s, a.id]
            )
          ),
      ],
      [
        "it was given another role",
        async (s) => {
          const role = await seededRoleId("premium").catch(() => seededRoleId("daily"));
          await withOwnerTx("operator", (tx) =>
            tx.query("update users set role_id = $2::uuid where id = $1::uuid", [s, role])
          );
        },
      ],
      [
        "it was banned",
        (s) =>
          withOwnerTx("operator", (tx) =>
            tx.query("update users set account_status = 'banned' where id = $1::uuid", [
              s,
            ])
          ),
      ],
    ];
    for (const [label, make] of cases) {
      const email = address("unsafe");
      const id = await staff(a, email);
      const g = pool.add(email);
      const strayId = await stray(a, g.sub, email);
      await make(strayId);
      const offered = await relinkIdentities(request({ email }), deps());
      expect([label, plan(offered)]).toEqual([
        label,
        expect.objectContaining({ code: "subject.held" }),
      ]);
      expect(
        (plan(offered) as { mergeCandidate?: string }).mergeCandidate
      ).toBeUndefined();
      const forced = await relinkIdentities(
        request({ email, mergeFrom: strayId, apply: true }),
        deps()
      );
      expect([label, plan(forced)]).toEqual([
        label,
        expect.objectContaining({ code: "merge.unsafe" }),
      ]);
      expect((await userRow(id))!.cognito_sub).toBe(id);
      expect(await userRow(strayId)).toBeDefined();
    }
  });

  it("hostile: the address typed in another case, with spaces — the same account, the same pool user", async () => {
    // The account's address stored in mixed case (a legacy row); the pool's in lower case.
    const stored = `Staff.Admin.${run}.${++n}@Relink.Example`;
    const id = await staff(a, stored);
    const g = pool.add(stored.toLowerCase());
    const report = await relinkIdentities(
      request({ email: `  ${stored.toUpperCase()}\t`, apply: true }),
      deps()
    );
    expect(pool.asked).toEqual([stored.toLowerCase(), stored.toUpperCase()]);
    expect(plan(report)).toMatchObject({ status: "relink", accountId: id });
    expect((await userRow(id))!.cognito_sub).toBe(g.sub);

    // The pool holds an address in mixed case (ListUsers matches exactly): found when typed as
    // the pool holds it, with spaces around it — and refused, not guessed, when typed otherwise.
    const mixed = `Mixed.${run}.${++n}@Relink.Example`;
    const id2 = await staff(a, mixed.toLowerCase());
    pool.add(mixed);
    const refused = await relinkIdentities(
      request({ email: mixed.toLowerCase() }),
      deps()
    );
    expect(plan(refused)).toMatchObject({ code: "pool.none" });
    const found = await relinkIdentities(request({ email: ` ${mixed} ` }), deps());
    expect(plan(found)).toMatchObject({ status: "relink", accountId: id2 });
  });

  it("hostile: SQL-ish and pattern characters in an address are data, never SQL or a pattern", async () => {
    const quoted = `o'brien+${run}.${++n}@relink.example`;
    const id = await staff(a, quoted);
    pool.add(quoted);
    const report = await relinkIdentities(
      request({ email: quoted, apply: true }),
      deps()
    );
    expect(plan(report)).toMatchObject({ status: "relink", accountId: id });

    // `_` and `%` are not wildcards: a_b does not find axb.
    const underscore = `a_b.${run}.${++n}@relink.example`;
    await staff(a, underscore.replace("a_b", "axb"));
    pool.add(underscore);
    const none = await relinkIdentities(request({ email: underscore }), deps());
    expect(plan(none)).toMatchObject({ code: "account.none" });
    const percent = `%.${run}.${++n}@relink.example`;
    pool.add(percent);
    const wild = await relinkIdentities(request({ email: percent }), deps());
    expect(plan(wild)).toMatchObject({ code: "account.none" });

    for (const injection of [
      `x@relink.example' or '1'='1`,
      `x@relink.example"; drop table users; --`,
      "x@relink.example\u0000",
    ]) {
      await expect(
        relinkIdentities(request({ email: injection }), deps())
      ).rejects.toThrow("--email is not");
    }
    const users = await withOwnerTx("operator", (tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from users where tenant_id = $1::uuid",
        [a.id]
      )
    );
    expect(users.rows[0]!.n).toBeGreaterThan(0);
  });

  it("hostile: a subject in another tenant — the pool's tenant, or an account there — is never re-linked to", async () => {
    const email = address("cross");
    const id = await staff(a, email);
    pool.add(email, { tenantId: b.id });
    const byPool = await relinkIdentities(request({ email, apply: true }), deps());
    expect(plan(byPool)).toMatchObject({ code: "pool.other_tenant" });

    const email2 = address("cross2");
    const id2 = await staff(a, email2);
    const g2 = pool.add(email2);
    const elsewhere = await stray(b, g2.sub, email2);
    for (const mergeFrom of [undefined, elsewhere]) {
      const r = await relinkIdentities(
        request({ email: email2, tenantId: a.id, mergeFrom, apply: true }),
        deps()
      );
      expect(plan(r)).toMatchObject({ code: "subject.held_elsewhere" });
    }
    expect((await userRow(id))!.cognito_sub).toBe(id);
    expect((await userRow(id2))!.cognito_sub).toBe(id2);
    expect(await userRow(elsewhere)).toMatchObject({
      tenant_id: b.id,
      cognito_sub: g2.sub,
    });
  });
});

dbDescribe("re-linking a whole pool (Postgres)", () => {
  it("hostile: an account bound to another subject that holds the new subject's id is never that identity's", async () => {
    const intruder = randomUUID();
    await insertUser(a, {
      id: intruder,
      cognitoSub: randomUUID(),
      roleId: await seededRoleId("super_admin"),
    });
    await expect(a.run(() => resolveAccount(intruder))).resolves.toEqual({
      kind: "conflict",
    });
    await expect(a.run(() => ensureUserProvisioned(intruder))).resolves.toBe("failed");
    await asSingle(a, async () => {
      const r = await requireActor(httpRequest("/api/x", signInAs(intruder)), {
        allowGuests: false,
      });
      expect(r.error?.status).toBe(403);
      await expect(r.error!.json()).resolves.toMatchObject({
        code: "account.identity_conflict",
      });
      expect(await a.run(() => resolvePermissions(intruder))).toBeNull();
      const guest = await guestPOST(
        httpRequest("/api/auth/guest", signInAs(intruder), "POST")
      );
      expect(guest.status).toBe(403);
    });
  });

  it("bulk (--all-staff, one tenant): staff only; one refusal stops the run; --skip-ambiguous re-links the rest; --merge-strays merges", async () => {
    const t = await createTestTenant();
    const s1 = address("bulk-1");
    const s2 = address("bulk-2");
    const s3 = address("bulk-3");
    const ordinary = address("bulk-free");
    const absent = address("bulk-absent");
    const id1 = await staff(t, s1);
    const id2 = await staff(t, s2, "admin");
    const id3 = await staff(t, s3);
    const idFree = await staff(t, ordinary, "free");
    await staff(t, absent, "admin");
    const g1 = pool.add(s1);
    const g2 = pool.add(s2);
    pool.add(s3, { emailVerified: false });
    pool.add(ordinary);

    const stopped = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id, apply: true }),
      deps()
    );
    expect(stopped).toMatchObject({ applied: false, stoppedBy: "refusal" });
    const byEmail = Object.fromEntries(stopped.plans.map((p) => [p.email, p.status]));
    expect(byEmail).toEqual({
      [s1]: "relink",
      [s2]: "relink",
      [s3]: "refused",
      [absent]: "absent",
    });
    expect((await userRow(id1))!.cognito_sub).toBe(id1);

    const skipped = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id, skipAmbiguous: true, apply: true }),
      deps()
    );
    expect(skipped.applied).toBe(true);
    expect((await userRow(id1))!.cognito_sub).toBe(g1.sub);
    expect((await userRow(id2))!.cognito_sub).toBe(g2.sub);
    expect((await userRow(id3))!.cognito_sub).toBe(id3);
    expect((await userRow(idFree))!.cognito_sub).toBe(idFree);
    expect((await relinkAudit(id1))[0]!.details).toMatchObject({ mode: "all-staff" });
    expect(new Set(skipped.invalidated)).toEqual(new Set([id1, g1.sub, id2, g2.sub]));

    // A stray for the third once verified: merged only with --merge-strays.
    pool.users = pool.users.filter((u) => u.email !== s3);
    const g3 = pool.add(s3);
    await stray(t, g3.sub, s3);
    const held = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id }),
      deps()
    );
    expect(held.plans.find((p) => p.email === s3)).toMatchObject({
      code: "subject.held",
    });
    const merged = await relinkIdentities(
      request({ scope: "all-staff", tenantId: t.id, mergeStrays: true, apply: true }),
      deps()
    );
    expect(merged.applied).toBe(true);
    expect((await userRow(id3))!.cognito_sub).toBe(g3.sub);
    expect(merged.plans.find((p) => p.email === s1)).toMatchObject({ status: "linked" });

    // --all covers the ordinary account too.
    const all = await relinkIdentities(request({ scope: "all", tenantId: t.id }), deps());
    expect(all.plans.find((p) => p.email === ordinary)).toMatchObject({
      status: "relink",
    });
  });
});
