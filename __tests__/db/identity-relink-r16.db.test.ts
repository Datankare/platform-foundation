/**
 * @jest-environment node
 */
/**
 * Review 16 of the identity re-link (TASK-174/176), against the replayed Postgres — the reviewer's
 * proofs (review16/__tests__/db/r16-hostile.db.test.ts), each asserting the FIXED behaviour, and
 * the federated case end to end:
 *
 *   D4f  a pre-move account whose own address was never verified is re-linked only on the
 *        operator's confirmation for that account (--confirm-unverified), recorded;
 *   M    the subject bound is the one every verifier names the request by — the pool user's
 *        `sub` (TASK-177: the platform's provider and Playform's alike), never its username
 *        (Google_… for a federated user) — and a Google-federated staff member reaches the staff
 *        account afterwards, exactly as a native one: requireActor, permissions, requireAdmin,
 *        the account guard;
 *   M2   an invalidation that was not published is reported per subject (exit 5);
 *   L1   --unverified-account naming another account than the target is refused;
 *   L2   --skip-ambiguous never applies an address the preview refused;
 *   L3   a legacy row (no cognito_sub) is asked of the pool by its id;
 *   L5   a dry run that refused anything exits 1;
 *   L7   a commit whose outcome is unknown is reported indeterminate, never "nothing changed".
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-relink-r16",
}));

import { randomInt, randomUUID } from "node:crypto";
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
import { resolveAccount } from "@/platform/auth/account-identity";
import { ensureUserProvisioned } from "@/platform/auth/user-provisioning";
import { runRequestScope } from "@/platform/tenancy/context";
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
import * as cacheModule from "@/platform/cache";
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

/**
 * A pool whose users' username and sub always differ: native users have a UUID username unlike
 * their sub, federated ones `Google_<digits>` — so binding the username (review 16's
 * `--subject username`) fails. The subject is the sub (TASK-177). ListUsers' filters are exact.
 */
class FakePool implements IdentityDirectory {
  readonly poolId = "us-east-1_9pRbNsCbE";
  users: DirectoryUser[] = [];
  askedSubjects: string[] = [];
  async findByEmail(email: string): Promise<readonly DirectoryUser[]> {
    return this.users.filter((u) => u.email === email);
  }
  async findBySub(sub: string): Promise<readonly DirectoryUser[]> {
    this.askedSubjects.push(sub);
    return this.users.filter((u) => u.sub === sub);
  }
  add(email: string, over: Partial<DirectoryUser> = {}): DirectoryUser {
    const sub = over.sub ?? randomUUID();
    const username = over.username ?? randomUUID();
    const u: DirectoryUser = {
      username,
      sub,
      email,
      emailVerified: true,
      enabled: true,
      status: "CONFIRMED",
      providers: [],
      tenantId: null,
      ...over,
    };
    expect(u.username).not.toBe(u.sub);
    this.users.push(u);
    return u;
  }
  /** A Google-federated user, as Cognito lists one: username Google_<id>, EXTERNAL_PROVIDER. */
  google(email: string): DirectoryUser {
    return this.add(email, {
      username: `Google_${String(Date.now())}${String(randomInt(1e9))}`,
      status: "EXTERNAL_PROVIDER",
      providers: ["Google"],
    });
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

let pool: FakePool;
const invalidated: string[] = [];
const run = randomUUID().slice(0, 8);
let n = 0;
const address = (label: string) => `${label}.${run}.${++n}@relink16.example`;

const HOUR = 3_600_000;
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
  reason: "review 16: pool replaced",
  ...over,
});

const commandEnv = () => ({
  ...process.env,
  DATABASE_OWNER_URL: "postgresql://owner:pw@localhost:5432/replay",
  DATABASE_SSL: "disable",
});

/** A staff account of `t` made in the old pool: a day old, an adult, its address verified there. */
async function staff(
  t: TestTenant,
  email: string,
  over: { role?: string; verified?: boolean; cognitoSub?: string | null } = {}
): Promise<string> {
  const id = randomUUID();
  await insertUser(t, {
    id,
    cognitoSub: over.cognitoSub === undefined ? id : over.cognitoSub,
    email,
    roleId: await seededRoleId(over.role ?? "super_admin"),
    createdAt: dayAgo(),
    emailVerified: over.verified ?? true,
  });
  await withOwnerTx("operator", (tx) =>
    tx.query(
      "update users set date_of_birth = '1980-01-01', age_verified = true, age_verified_at = now() where id = $1::uuid",
      [id]
    )
  );
  return id;
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
const only = (r: { plans: readonly AccountPlan[] }) => {
  expect(r.plans).toHaveLength(1);
  return r.plans[0]!;
};

// ── A provider for the sign-ins afterwards (the platform's verifier: payload.sub = subject) ──

let tokens = new Map<string, TokenPayload>();
function signInAs(subject: string, over: Partial<TokenPayload> = {}): string {
  const token = `tok-${randomUUID()}`;
  tokens.set(token, {
    sub: subject,
    email: "",
    emailVerified: true,
    identityProviders: ["Google"],
    iat: 0,
    exp: Math.floor(Date.now() / 1000) + 600,
    mfaEnabled: true,
    ...over,
  });
  return token;
}
const httpRequest = (path: string, token: string) =>
  new NextRequest(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.16" },
  });

const saved = { mode: process.env.TENANCY_MODE, tenant: process.env.TENANT_ID };
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
    const base = createMockAuthProvider();
    const provider: AuthProvider = {
      ...base,
      verifyToken: async (t: string) => tokens.get(t) ?? null,
      getUserTenant: async () => null,
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
  clearConfigCache();
  await clearPermissionsCache();
  resetRateLimiter();
});

/** What a sign-in with `subject` reaches in `t`: the actor, its permissions, the admin guard. */
async function signedIn(t: TestTenant, subject: string) {
  const perms = await t.run(() => resolvePermissions(subject));
  return asSingle(t, async () => {
    const token = signInAs(subject);
    const actor = await requireActor(httpRequest("/api/x", token), {
      allowGuests: false,
    });
    const guarded = await requireActorWithStatus(
      httpRequest("/api/x", token),
      "translate",
      {
        allowGuests: false,
      }
    );
    const admin = await requireAdmin(
      httpRequest("/api/admin/config", token),
      "can_access_admin"
    );
    const cached = await getCachedPermissions(subject);
    return { perms, actor, guarded, admin, cached };
  });
}

// ── The federated case, end to end (Playform's staff: Google, pool us-east-1_9pRbNsCbE) ────

dbDescribe(
  "TASK-177: the subject bound is the sub — a Google-federated staff member, as a native one",
  () => {
    it("a Google-federated staff member is bound to its sub, never Google_… — requireActor, permissions, requireAdmin, the account guard reach the staff account", async () => {
      const t = await createTestTenant();
      const email = address("google-staff");
      const id = await staff(t, email);
      const g = pool.google(email);
      expect(g.username).toMatch(/^Google_\d+$/);

      const dry = await relinkIdentities(request({ email, tenantId: t.id }), deps());
      expect(only(dry)).toMatchObject({
        status: "relink",
        accountId: id,
        previousSubject: id,
        newSubject: g.sub,
        signsInWith: ["Google"],
      });
      const done = await relinkIdentities(
        request({ email, tenantId: t.id, apply: true }),
        deps()
      );
      expect(done.applied).toBe(true);
      expect(done).not.toHaveProperty("subjectAttribute");
      expect(await userRow(id)).toMatchObject({ id, cognito_sub: g.sub });
      const details = (await relinkAudit(id))[0]!.details as Record<string, unknown>;
      expect(details).toMatchObject({ signsInWith: ["Google"] });
      expect(details).not.toHaveProperty("subjectAttribute");
      expect(invalidated.sort()).toEqual([id, g.sub].sort());

      // Every verifier names the request by the sub: it is the staff account.
      await expect(t.run(() => resolveAccount(g.sub))).resolves.toEqual({
        kind: "bound",
        accountId: id,
      });
      const after = await signedIn(t, g.sub);
      expect(after.perms).toMatchObject({ userId: id, roleName: "super_admin" });
      expect(after.cached).toMatchObject({ userId: id, roleName: "super_admin" });
      expect(after.actor.actor).toMatchObject({ kind: "user", id, tenantId: t.id });
      expect(after.guarded.error).toBeUndefined();
      expect(after.guarded.actor).toMatchObject({ kind: "user", id });
      expect(after.admin.error).toBeUndefined();
      expect(after.admin.admin).toMatchObject({
        userId: id,
        sub: g.sub,
        roleName: "super_admin",
      });

      // The pool's username names nothing: it is never a subject.
      await expect(t.run(() => resolveAccount(g.username))).resolves.toMatchObject({
        kind: "unprovisioned",
      });
      expect(await t.run(() => resolvePermissions(g.username))).toBeNull();

      // Run again: linked — found by the same subject ("bound in pool" asks the sub).
      const again = await relinkIdentities(request({ email, tenantId: t.id }), deps());
      expect(only(again)).toMatchObject({ status: "linked", accountId: id });
    });

    it("a Google-federated staff member without a Cognito second factor (Cognito applies none to federated sign-in) is refused /admin while auth.staff_mfa_required is on — auth.mfa_required, not a binding failure", async () => {
      const t = await createTestTenant();
      const email = address("google-nomfa");
      const id = await staff(t, email);
      const g = pool.google(email);
      await relinkIdentities(request({ email, tenantId: t.id, apply: true }), deps());
      const refused = await asSingle(t, () =>
        requireAdmin(
          httpRequest("/api/admin/config", signInAs(g.sub, { mfaEnabled: false })),
          "can_access_admin"
        )
      );
      expect(refused.error?.status).toBe(403);
      expect(await refused.error?.json()).toMatchObject({ code: "auth.mfa_required" });
      // The account itself is reached: an ordinary route serves it.
      const actor = await asSingle(t, () =>
        requireActor(httpRequest("/api/x", signInAs(g.sub, { mfaEnabled: false })), {
          allowGuests: false,
        })
      );
      expect(actor.actor).toMatchObject({ kind: "user", id });
    });

    it("a native and a federated staff member re-link identically: the same plan, the same binding (the sub), the same reach", async () => {
      const t = await createTestTenant();
      const nativeEmail = address("native-staff");
      const googleEmail = address("google-twin");
      const nativeId = await staff(t, nativeEmail);
      const googleId = await staff(t, googleEmail);
      const native = pool.add(nativeEmail);
      const google = pool.google(googleEmail);
      const r = await relinkIdentities(
        request({ scope: "all-staff", tenantId: t.id, apply: true }),
        deps()
      );
      expect(r.applied).toBe(true);
      const shape = (email: string) => {
        const {
          email: _e,
          accountId: _a,
          previousSubject: _p,
          newSubject: _n,
          signsInWith: _s,
          ...rest
        } = planFor(r, email)[0] as Record<string, unknown>;
        return rest;
      };
      expect(shape(googleEmail)).toEqual(shape(nativeEmail));
      for (const [id, u] of [
        [nativeId, native],
        [googleId, google],
      ] as const) {
        expect(await userRow(id)).toMatchObject({ cognito_sub: u.sub });
        const after = await signedIn(t, u.sub);
        expect(after.actor.actor).toMatchObject({ kind: "user", id });
        expect(after.guarded.actor).toMatchObject({ kind: "user", id });
        expect(after.admin.admin).toMatchObject({ userId: id, roleName: "super_admin" });
        await expect(t.run(() => resolveAccount(u.username))).resolves.toMatchObject({
          kind: "unprovisioned",
        });
      }
    });

    it("an account already bound to a current-pool identity is found by its sub — a federated holder's too", async () => {
      const t = await createTestTenant();
      const email = address("bound-sub");
      const holder = pool.google(address("elsewhere"));
      const id = await staff(t, email, { cognitoSub: holder.sub });
      pool.add(email);
      const r = await relinkIdentities(request({ email, tenantId: t.id }), deps());
      expect(only(r)).toMatchObject({ code: "account.bound_in_pool" });
      expect(pool.askedSubjects).toContain(holder.sub);
      expect(pool.askedSubjects).not.toContain(holder.username);
      expect(await userRow(id)).toMatchObject({ cognito_sub: holder.sub });
    });

    it("two addresses onto one federated identity in a bulk run: both refused (subject.contested), by the sub", async () => {
      const t1 = await createTestTenant();
      const t2 = await createTestTenant();
      const email = address("contested");
      const id1 = await staff(t1, email);
      const id2 = await staff(t2, email);
      const g = pool.google(email);
      const r = await relinkIdentities(
        request({ scope: "all-staff", skipAmbiguous: true }),
        deps({ onlyTenants: [t1.id, t2.id] })
      );
      expect(planFor(r, email).map((p) => (p as { code?: string }).code)).toEqual([
        "subject.contested",
        "subject.contested",
      ]);
      expect(await userRow(id1)).toMatchObject({ cognito_sub: id1 });
      expect(await userRow(id2)).toMatchObject({ cognito_sub: id2 });
      expect(g.username).toMatch(/^Google_/);
    });
  }
);

// ── The reviewer's proofs, fixed ─────────────────────────────────────────────────────────────

dbDescribe(
  "review 16: the reviewer's proofs, asserting the fixed behaviour (D4f, L1, L2)",
  () => {
    it("D4f: a pre-move STAFF account whose address was never verified is NOT moved to whoever verifies it in the new pool (bulk --all-staff --apply) — refused and listed until confirmed for that account", async () => {
      const t = await createTestTenant();
      const typo = address("typo");
      const id = await staff(t, typo, { verified: false, role: "super_admin" });
      const fine = address("fine");
      const idFine = await staff(t, fine);
      const gFine = pool.add(fine);
      const stranger = pool.add(typo);

      const r = await relinkIdentities(
        request({ scope: "all-staff", tenantId: t.id, apply: true }),
        deps()
      );
      expect(r).toMatchObject({ applied: false, stoppedBy: "refusal" });
      expect(planFor(r, typo)).toEqual([
        expect.objectContaining({
          status: "refused",
          code: "account.needs_confirmation",
          needsConfirmation: { accountId: id, tenantId: t.id, role: "super_admin" },
        }),
      ]);
      expect(await userRow(id)).toMatchObject({ cognito_sub: id });
      await expect(t.run(() => resolveAccount(stranger.sub))).resolves.toEqual({
        kind: "unprovisioned",
        accountId: stranger.sub,
      });
      expect(await t.run(() => resolvePermissions(stranger.sub))).toBeNull();

      // The dry run says exactly which account needs it, and why; exit 1.
      const out: string[] = [];
      const code = await runRelinkCommand(
        [
          "--all-staff",
          "--tenant",
          t.id,
          "--created-before",
          movedAt(),
          "--operator",
          "op",
          "--reason",
          "pool moved",
        ],
        commandEnv(),
        { out: (l) => out.push(l), err: (l) => out.push(l) },
        { directory: pool, machine: { osUser: "o", host: "h" } }
      );
      expect(code).toBe(EXIT.refused);
      const text = out.join("\n");
      expect(text).toContain(`refused  ${typo} [account.needs_confirmation]`);
      expect(text).toContain("never verified");
      expect(text).toContain(
        `--confirm-unverified ${id}   (${typo}, tenant ${t.id}, role super_admin)`
      );

      // --skip-ambiguous re-links the rest, never the unconfirmed one.
      const skipped = await relinkIdentities(
        request({ scope: "all-staff", tenantId: t.id, apply: true, skipAmbiguous: true }),
        deps()
      );
      expect(skipped.applied).toBe(true);
      expect(await userRow(idFine)).toMatchObject({ cognito_sub: gFine.sub });
      expect(await userRow(id)).toMatchObject({ cognito_sub: id });

      // Confirmed for that account: re-linked, and the record says so.
      const confirmed = await relinkIdentities(
        request({
          scope: "all-staff",
          tenantId: t.id,
          apply: true,
          confirmUnverified: [id],
        }),
        deps()
      );
      expect(planFor(confirmed, typo)).toEqual([
        expect.objectContaining({
          status: "relink",
          accountId: id,
          accountUnverified: true,
          unverifiedConfirmed: true,
        }),
      ]);
      expect(await userRow(id)).toMatchObject({ cognito_sub: stranger.sub });
      expect((await relinkAudit(id))[0]!.details).toMatchObject({
        accountUnverified: true,
        unverifiedConfirmed: true,
      });
    });

    it("D4f: a confirmation for another account confirms nothing — reported as unused", async () => {
      const t = await createTestTenant();
      const email = address("other-confirm");
      const id = await staff(t, email, { verified: false });
      pool.add(email);
      const stray = randomUUID();
      const r = await relinkIdentities(
        request({ email, tenantId: t.id, confirmUnverified: [stray] }),
        deps()
      );
      expect(only(r)).toMatchObject({ code: "account.needs_confirmation" });
      expect(r.unusedConfirmations).toEqual([stray]);
      expect(await userRow(id)).toMatchObject({ cognito_sub: id });
    });

    it("L1: --unverified-account naming X is refused when another pre-move account Y is verified (never silently Y)", async () => {
      const t = await createTestTenant();
      const email = address("named");
      const x = await staff(t, email, { verified: false });
      const y = await staff(t, email, { verified: true });
      pool.add(email);
      const r = await relinkIdentities(
        request({ email, tenantId: t.id, unverifiedAccount: x, apply: true }),
        deps()
      );
      expect(only(r)).toMatchObject({ status: "refused", code: "account.unverified" });
      expect((only(r) as { detail: string }).detail).toContain(`account ${y}`);
      expect(await userRow(x)).toMatchObject({ cognito_sub: x });
      expect(await userRow(y)).toMatchObject({ cognito_sub: y });
      // Without the flag, Y (verified) is the target.
      const plain = await relinkIdentities(request({ email, tenantId: t.id }), deps());
      expect(only(plain)).toMatchObject({ status: "relink", accountId: y });
    });

    it("L2: --skip-ambiguous: an address refused in the preview stays refused in a later chunk though the data changed meanwhile (never applied unpreviewed)", async () => {
      const t = await createTestTenant();
      const e = [1, 2, 3].map((i) => `r16-${i}.${run}@relink16.example`);
      for (const x of e) {
        await staff(t, x);
        pool.add(x);
      }
      const e4 = `r16-4.${run}@relink16.example`;
      const d1 = await staff(t, e4, { verified: true });
      const d2 = await staff(t, e4, { verified: true });
      pool.add(e4);
      let changed = false;
      const r = await relinkIdentities(
        request({ scope: "all-staff", tenantId: t.id, skipAmbiguous: true, apply: true }),
        deps({
          chunkSize: 2,
          invalidate: async (s: string) => {
            invalidated.push(s);
            if (!changed) {
              changed = true;
              await withOwnerTx("operator", (tx) =>
                tx.query("update users set deleted_at = now() where id = $1::uuid", [d2])
              );
            }
          },
        })
      );
      expect(planFor(r, e4)).toEqual([
        expect.objectContaining({ status: "refused", code: "account.many" }),
      ]);
      expect(await userRow(d1)).toMatchObject({ cognito_sub: d1 });
      expect(r.chunks.map((c) => c.outcome)).toEqual(["applied", "applied"]);
    });
  }
);

dbDescribe(
  "review 16: the reviewer's proofs, asserting the fixed behaviour (M2, L3, L5, L7)",
  () => {
    it("M2: a cache that fails the publish is reported per subject, even when it answers the probe afterwards — exit 5, never 'on every instance'", async () => {
      const t = await createTestTenant();
      const email = address("m2");
      const id = await staff(t, email);
      const g = pool.add(email);
      const real = cacheModule.getCache;
      let failing = true;
      const spy = jest.spyOn(cacheModule, "getCache").mockImplementation(() => {
        if (failing) throw new Error("cache down");
        return real();
      });
      const out: string[] = [];
      let code: number;
      try {
        code = await runRelinkCommand(
          [
            "--email",
            email,
            "--tenant",
            t.id,
            "--created-before",
            movedAt(),
            "--operator",
            "op",
            "--reason",
            "pool moved",
            "--apply",
          ],
          commandEnv(),
          { out: (l) => out.push(l), err: (l) => out.push(l) },
          {
            directory: pool,
            machine: { osUser: "o", host: "h" },
            // By the time a probe runs, the cache answers again: never taken for the publish.
            cacheReach: async () => {
              failing = false;
              return "shared";
            },
          }
        );
      } finally {
        spy.mockRestore();
      }
      const text = out.join("\n");
      expect(code).toBe(EXIT.appliedNotVoided);
      expect(text).toContain("Not voided for 2 subject(s)");
      expect(text).toContain(
        "not published (permissions: cache down; token verifications: cache down)"
      );
      expect(text).toContain("The change itself is committed.");
      expect(text).not.toContain("on every instance");
      expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
      const { logger } = jest.requireMock("@/lib/logger") as {
        logger: { error: jest.Mock };
      };
      expect(logger.error.mock.calls.map((c) => String(c[0]))).toEqual(
        expect.arrayContaining([expect.stringContaining("not published")])
      );
    });

    it("M2: one subject's publish fails, the other's succeeds — reported per subject", async () => {
      const t = await createTestTenant();
      const email = address("m2-partial");
      const id = await staff(t, email);
      const g = pool.add(email);
      const real = cacheModule.getCache;
      const spy = jest.spyOn(cacheModule, "getCache").mockImplementation(() => {
        const c = real();
        return {
          ...c,
          get: c.get.bind(c),
          delete: c.delete.bind(c),
          set: async (key: string, ...rest: unknown[]) => {
            if (key.endsWith(g.sub)) throw new Error("refused");
            return (c.set as (...a: unknown[]) => Promise<void>)(key, ...rest);
          },
        } as ReturnType<typeof real>;
      });
      const out: string[] = [];
      let code: number;
      try {
        code = await runRelinkCommand(
          [
            "--email",
            email,
            "--tenant",
            t.id,
            "--created-before",
            movedAt(),
            "--operator",
            "op",
            "--reason",
            "pool moved",
            "--apply",
          ],
          commandEnv(),
          { out: (l) => out.push(l), err: (l) => out.push(l) },
          {
            directory: pool,
            machine: { osUser: "o", host: "h" },
            cacheReach: async () => "shared",
          }
        );
      } finally {
        spy.mockRestore();
      }
      const text = out.join("\n");
      expect(code).toBe(EXIT.appliedNotVoided);
      expect(text).toContain(`Not voided for 1 subject(s) (${g.sub.slice(0, 8)}…`);
      expect(text).toContain("voided for 1 subject(s), on every instance");
      expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
    });

    it("L3: a legacy row (cognito_sub null) whose id is a subject of this pool is NOT moved — asked of the pool by its id (account.bound_in_pool)", async () => {
      const t = await createTestTenant();
      const email = address("legacy");
      const id = await staff(t, email, { cognitoSub: null });
      // The legacy row is bound to the subject = its id (bindingOf), and the pool holds that subject.
      pool.add(address("elsewhere"), { sub: id });
      await expect(t.run(() => resolveAccount(id))).resolves.toEqual({
        kind: "bound",
        accountId: id,
      });
      pool.add(email);
      const r = await relinkIdentities(
        request({ email, tenantId: t.id, apply: true }),
        deps()
      );
      expect(only(r)).toMatchObject({ status: "refused", code: "account.bound_in_pool" });
      expect(pool.askedSubjects).toContain(id);
      expect(await userRow(id)).toMatchObject({ cognito_sub: null });
    });

    it("L3: a legacy row whose id is no subject of this pool is re-linked; its id (its old subject) is voided", async () => {
      const t = await createTestTenant();
      const email = address("legacy-ok");
      const id = await staff(t, email, { cognitoSub: null });
      const g = pool.add(email);
      const r = await relinkIdentities(
        request({ email, tenantId: t.id, apply: true }),
        deps()
      );
      expect(only(r)).toMatchObject({ status: "relink", previousSubject: null });
      expect(await userRow(id)).toMatchObject({ cognito_sub: g.sub });
      expect(invalidated.sort()).toEqual([id, g.sub].sort());
    });

    it("L5: a dry run with --skip-ambiguous and a refused address exits 1 (a dry run that refused anything is never 0)", async () => {
      const t = await createTestTenant();
      const ok = address("dryok");
      await staff(t, ok);
      pool.add(ok);
      const bad = address("drybad");
      await staff(t, bad);
      await staff(t, bad);
      pool.add(bad);
      const out: string[] = [];
      const code = await runRelinkCommand(
        [
          "--all-staff",
          "--tenant",
          t.id,
          "--created-before",
          movedAt(),
          "--operator",
          "op",
          "--reason",
          "pool moved",
          "--skip-ambiguous",
        ],
        commandEnv(),
        { out: (l) => out.push(l), err: (l) => out.push(l) },
        { directory: pool, machine: { osUser: "o", host: "h" } }
      );
      expect(out.join("\n")).toContain("refused  " + bad);
      expect(out.join("\n")).toContain("--apply would skip it and re-link the rest");
      expect(code).toBe(EXIT.refused);
    });

    it("L7: the connection drops while a chunk is committing — indeterminate (it may have committed), its subjects voided, never 'nothing changed'; the verify run says what holds", async () => {
      const t = await createTestTenant();
      const email = address("commit-lost");
      const id = await staff(t, email);
      const g = pool.add(email);
      const r = await relinkIdentities(
        request({ email, tenantId: t.id, apply: true }),
        deps({
          // A deferred constraint trigger ends this very connection at COMMIT.
          onChunk: async (_c: number, tx: { query: (q: string) => Promise<unknown> }) => {
            await tx.query(
              "create function pg_temp.r16_die() returns trigger language plpgsql as $$ begin perform pg_terminate_backend(pg_backend_pid()); perform pg_sleep(1); return null; end $$"
            );
            await tx.query("create temp table r16_commit_bomb (x int) on commit drop");
            await tx.query(
              "create constraint trigger r16_commit_bomb after insert on r16_commit_bomb deferrable initially deferred for each row execute function pg_temp.r16_die()"
            );
            await tx.query("insert into r16_commit_bomb values (1)");
          },
        })
      );
      expect(r).toMatchObject({ applied: false, stoppedBy: "indeterminate" });
      expect(r.chunks).toEqual([
        expect.objectContaining({ outcome: "indeterminate", relinked: 0 }),
      ]);
      expect(r.failure?.message).toContain("whether it took effect is unknown");
      expect(invalidated.sort()).toEqual([id, g.sub].sort());
      // Here the server rolled it back: the verify run (a dry run) says it is still to re-link.
      const verify = await relinkIdentities(request({ email, tenantId: t.id }), deps());
      expect(only(verify)).toMatchObject({ status: "relink", accountId: id });
      expect(await userRow(id)).toMatchObject({ cognito_sub: id });
    });

    it("a first sign-in of the new identity before the re-link is a stray of the default role — never staff", async () => {
      const t = await createTestTenant();
      const email = address("before");
      await staff(t, email);
      const g = pool.add(email);
      await expect(
        t.run(() => ensureUserProvisioned(g.sub, { email, emailVerified: true }))
      ).resolves.toBe("created");
      expect(await t.run(() => resolvePermissions(g.sub))).toMatchObject({
        roleName: "free",
      });
    });
  }
);
