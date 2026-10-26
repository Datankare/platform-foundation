/**
 * @jest-environment node
 */
/**
 * TASK-177: the subject is the Cognito `sub` — against the replayed Postgres, through the
 * platform's own CognitoAuthProvider (signed tokens, GetUser and the administrative calls answered
 * by a pool stand-in that behaves as Cognito does).
 *
 * Review 16 found the platform's provider named a request by the pool's username (`Google_1093…`
 * for a federated user) while provisioning accepts only a UUID subject: a brand-new Google user
 * could never be provisioned. The provider now names every identity by its `sub` (a UUID for a
 * native and a federated user alike), and these cases prove both kinds identically:
 *
 *   provision  a first request provisions the account (id = subject = the sub);
 *   resolve    requireActor, the permissions, requireAdmin, the account guard, the identity tenant
 *              (shared mode: the tenant is assigned with AdminUpdateUserAttributes addressed by
 *              the pool's username — Cognito accepts a native user's sub there, never a federated
 *              user's — and read back from GetUser);
 *   re-link    an old-pool staff account is re-linked to the sub and reached afterwards;
 *   revoke     a token names the sub (tokenSubject; sign-out revokes the verified payload's sub —
 *              review 17 M1) and the provider's sessions name the sub.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-subject-sub",
}));

import { randomInt, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getCache } from "@/platform/cache";
import { withOwnerTx } from "@/platform/data";
import { registerAuthProvider } from "@/platform/auth/config";
import { CognitoAuthProvider, TENANT_ATTRIBUTE } from "@/platform/auth/cognito-provider";
import { clearConfigCache } from "@/platform/auth/platform-config";
import { resolvePermissions } from "@/platform/auth/permissions";
import { clearPermissionsCache } from "@/platform/auth/permissions-cache";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { requireActor } from "@/platform/auth/middleware";
import { requireActorWithStatus } from "@/platform/auth/actor-guard";
import { resolveAccount } from "@/platform/auth/account-identity";
import { tokenSubject } from "@/platform/auth/token-verification";
import {
  directoryUserFrom,
  type DirectoryUser,
  type IdentityDirectory,
} from "@/platform/auth/identity-directory";
import { relinkIdentities } from "@/platform/auth/identity-relink";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import { ensureIdentityTenant } from "@/platform/tenancy/identity";
import { runRequestScope, runWithTenant } from "@/platform/tenancy/context";
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
import { seededRoleId } from "../helpers/db-admin";
import { TEST_JWKS, signJwt } from "../helpers/test-jwt";

const POOL_ID = "us-east-1_SubPool01";
const CLIENT_ID = "test-client-id";
const ISS = `https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}`;

// ── The pool stand-in (Cognito's JSON API, as the provider calls it over fetch) ─────────────

interface PoolUser {
  readonly username: string;
  readonly sub: string;
  readonly email: string;
  /** Federated: the `identities` attribute; absent for a native user. */
  readonly provider?: string;
  tenantId?: string;
}

class CognitoStandIn {
  users: PoolUser[] = [];
  /** The Username every administrative call named, in order. */
  adminCalls: { action: string; username: string }[] = [];

  native(email: string): PoolUser {
    // A pool that signs in by address names a native user by its sub.
    const sub = randomUUID();
    return this.push({ username: sub, sub, email });
  }
  google(email: string): PoolUser {
    return this.push({
      username: `Google_${String(Date.now())}${String(randomInt(1e9))}`,
      sub: randomUUID(),
      email,
      provider: "Google",
    });
  }
  private push(u: PoolUser): PoolUser {
    this.users.push(u);
    return u;
  }

  attributes(u: PoolUser) {
    return [
      { Name: "sub", Value: u.sub },
      { Name: "email", Value: u.email },
      { Name: "email_verified", Value: "true" },
      ...(u.provider
        ? [
            {
              Name: "identities",
              Value: JSON.stringify([{ providerName: u.provider, userId: "1093" }]),
            },
          ]
        : []),
      ...(u.tenantId ? [{ Name: TENANT_ATTRIBUTE, Value: u.tenantId }] : []),
    ];
  }

  /**
   * Cognito's rule for an administrative call's Username: the user's username — or a local
   * (native) user's sub. A federated user's sub names nobody (UserNotFoundException).
   */
  private byAdminName(name: string): PoolUser | undefined {
    return this.users.find(
      (u) => u.username === name || (u.provider === undefined && u.sub === name)
    );
  }

  answer(action: string, body: Record<string, unknown>): [number, unknown] {
    if (action === "GetUser") {
      const claims = JSON.parse(
        Buffer.from(String(body.AccessToken).split(".")[1]!, "base64url").toString()
      ) as { sub: string };
      const u = this.users.find((x) => x.sub === claims.sub);
      if (!u) return [400, { __type: "NotAuthorizedException" }];
      return [
        200,
        {
          Username: u.username,
          UserAttributes: this.attributes(u),
          // Both kinds report a second factor here, so what is compared is the binding alone.
          UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
        },
      ];
    }
    if (action === "AdminUpdateUserAttributes" || action === "AdminGetUser") {
      const name = String(body.Username);
      this.adminCalls.push({ action, username: name });
      const u = this.byAdminName(name);
      if (!u) return [400, { __type: "UserNotFoundException" }];
      if (action === "AdminGetUser")
        return [200, { Username: u.username, UserAttributes: this.attributes(u) }];
      const attrs = body.UserAttributes as { Name: string; Value: string }[];
      u.tenantId = attrs.find((a) => a.Name === TENANT_ATTRIBUTE)?.Value;
      return [200, {}];
    }
    throw new Error(`unexpected Cognito call: ${action}`);
  }

  /** The pool as the re-link's directory reads it (ListUsers' shape, through the real reader). */
  directory(): IdentityDirectory {
    const listed = (u: PoolUser): DirectoryUser =>
      directoryUserFrom({
        Username: u.username,
        Enabled: true,
        UserStatus: u.provider ? "EXTERNAL_PROVIDER" : "CONFIRMED",
        Attributes: this.attributes(u),
      })!;
    return {
      poolId: POOL_ID,
      findByEmail: async (email) =>
        this.users.filter((u) => u.email === email).map(listed),
      findBySub: async (sub) => this.users.filter((u) => u.sub === sub).map(listed),
    };
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

let pool: CognitoStandIn;
const originalFetch = global.fetch;
const run = randomUUID().slice(0, 8);
let n = 0;
const address = (label: string) => `${label}.${run}.${++n}@subject.example`;
const nowS = () => Math.floor(Date.now() / 1000);
const HOUR = 3_600_000;

/** An access token as the pool signs it for the app client. */
const tokenFor = (u: PoolUser) =>
  signJwt({
    sub: u.sub,
    username: u.username,
    token_use: "access",
    client_id: CLIENT_ID,
    iss: ISS,
    iat: nowS() - 10,
    exp: nowS() + 3600,
    origin_jti: randomUUID(),
    jti: randomUUID(),
  });

const httpRequest = (path: string, token: string) =>
  new NextRequest(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.77" },
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

const userRow = async (id: string) =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query<{ id: string; cognito_sub: string | null; tenant_id: string }>(
        "select id, cognito_sub, tenant_id from users where id = $1::uuid",
        [id]
      )
    )
  ).rows[0];

/** Make the account staff, an adult (the consent gate), as an operator would. */
async function makeStaff(id: string): Promise<void> {
  const role = await seededRoleId("super_admin");
  await withOwnerTx("operator", (tx) =>
    tx.query(
      "update users set role_id = $2::uuid, date_of_birth = '1980-01-01', age_verified = true, age_verified_at = now() where id = $1::uuid",
      [id, role]
    )
  );
  await clearPermissionsCache();
}

/** Everything a request with `token` reaches in `t` (single mode). */
async function reach(t: TestTenant, token: string) {
  return asSingle(t, async () => {
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
    return { actor, guarded, admin };
  });
}

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
  });
  afterAll(async () => {
    global.fetch = originalFetch;
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

let provider: CognitoAuthProvider;
beforeEach(async () => {
  pool = new CognitoStandIn();
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const target = headers["X-Amz-Target"] ?? headers["x-amz-target"] ?? "";
    const [status, body] = pool.answer(
      target.split(".").pop() ?? "",
      JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    );
    return { ok: status < 400, status, json: async () => body };
  }) as unknown as typeof fetch;
  provider = new CognitoAuthProvider({
    region: "us-east-1",
    userPoolId: POOL_ID,
    clientId: CLIENT_ID,
    timeoutMs: 5000,
    jwks: TEST_JWKS,
    adminCredentials: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
  });
  registerAuthProvider(provider);
  await getCache().clear();
  clearConfigCache();
  await clearPermissionsCache();
  resetRateLimiter();
});
afterEach(() => {
  global.fetch = originalFetch;
});

const KINDS = [
  ["native", (p: CognitoStandIn, email: string) => p.native(email)],
  ["Google-federated", (p: CognitoStandIn, email: string) => p.google(email)],
] as const;

dbDescribe("TASK-177: the subject is the sub — native and federated users alike", () => {
  it.each(KINDS)(
    "a %s user: the verified token names the sub; a first request provisions the account (id = sub); requireActor, the permissions, the account guard and requireAdmin resolve it",
    async (_kind, make) => {
      const t = await createTestTenant();
      const u = make(pool, address("first"));
      const token = tokenFor(u);

      const payload = await provider.verifyToken(token);
      expect(payload).toMatchObject({ sub: u.sub, email: u.email, emailVerified: true });
      expect(payload!.sub).toMatch(/^[0-9a-f-]{36}$/);
      expect(tokenSubject(token)).toBe(u.sub);

      // The account guard provisions on first use — a UUID subject, so a Google user too.
      const first = await reach(t, token);
      // Provisioned, then held at the age gate (a new account has no date of birth yet) — never
      // account.not_provisioned, which a username subject was for a Google user.
      expect(first.actor.actor).toMatchObject({ kind: "user", id: u.sub });
      expect(first.guarded.error?.status).toBe(403);
      expect(await first.guarded.error?.json()).toMatchObject({
        code: "account.age_unverified",
      });
      expect(await userRow(u.sub)).toMatchObject({ id: u.sub, cognito_sub: u.sub });
      await expect(t.run(() => resolveAccount(u.sub))).resolves.toEqual({
        kind: "bound",
        accountId: u.sub,
      });
      // The username is never a subject: it names nothing.
      if (u.username !== u.sub)
        await expect(t.run(() => resolveAccount(u.username))).resolves.toMatchObject({
          kind: "unprovisioned",
        });
      // An ordinary account: no admin.
      expect(first.admin.error?.status).toBe(403);

      await makeStaff(u.sub);
      expect(await t.run(() => resolvePermissions(u.sub))).toMatchObject({
        userId: u.sub,
        roleName: "super_admin",
      });
      const staff = await reach(t, tokenFor(u));
      expect(staff.actor.actor).toMatchObject({
        kind: "user",
        id: u.sub,
        tenantId: t.id,
      });
      expect(staff.guarded.actor).toMatchObject({ kind: "user", id: u.sub });
      expect(staff.admin.error).toBeUndefined();
      expect(staff.admin.admin).toMatchObject({
        userId: u.sub,
        sub: u.sub,
        roleName: "super_admin",
      });
    }
  );

  it.each(KINDS)(
    "a %s user in a shared deployment: the identity joins the tenant (AdminUpdateUserAttributes by the pool's username), and the next verification carries it",
    async (_kind, make) => {
      const t = await createTestTenant();
      const u = make(pool, address("shared"));
      const token = tokenFor(u);
      await expect(
        runWithTenant({ tenantId: t.id, mode: "shared" }, () =>
          ensureIdentityTenant(token)
        )
      ).resolves.toEqual({ ok: true });
      // Addressed as Cognito requires: a federated user's sub would name nobody.
      expect(pool.adminCalls).toEqual([
        { action: "AdminUpdateUserAttributes", username: u.username },
      ]);
      expect(u.tenantId).toBe(t.id);
      await expect(provider.getUserTenant(u.sub)).resolves.toBe(t.id);
      expect(await provider.verifyToken(tokenFor(u))).toMatchObject({
        sub: u.sub,
        tenantId: t.id,
      });
      // Signed in again elsewhere: refused, the tenant is the pool's.
      const other = await createTestTenant();
      await expect(
        runWithTenant({ tenantId: other.id, mode: "shared" }, () =>
          ensureIdentityTenant(tokenFor(u))
        )
      ).resolves.toEqual({ ok: false, code: "tenant.mismatch" });
    }
  );

  it("the stand-in is Cognito's rule: a federated user's sub is no administrative name (why the provider addresses it by its username)", async () => {
    const g = pool.google(address("rule"));
    const fresh = new CognitoAuthProvider({
      region: "us-east-1",
      userPoolId: POOL_ID,
      clientId: CLIENT_ID,
      timeoutMs: 5000,
      jwks: TEST_JWKS,
      adminCredentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
    const tenant = randomUUID();
    // Never seen a token of the user: addressed by its sub — Cognito refuses it, fail closed.
    await expect(fresh.assignTenant(g.sub, tenant)).resolves.toMatchObject({
      success: false,
    });
    // Seen (a signed token names its username): addressed by it, and assigned.
    await fresh.verifyToken(tokenFor(g));
    await expect(fresh.assignTenant(g.sub, tenant)).resolves.toEqual({ success: true });
    expect(g.tenantId).toBe(tenant);
    expect(pool.adminCalls.map((c) => c.username)).toEqual([g.sub, g.username]);
  });

  it.each(KINDS)(
    "a %s staff member's old-pool account re-links to the sub and is reached afterwards",
    async (_kind, make) => {
      const t = await createTestTenant();
      const email = address("relink");
      const id = randomUUID();
      const role = await seededRoleId("super_admin");
      await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query(
          `insert into users (id, cognito_sub, email, role_id, tenant_id, created_at, email_verified,
                              date_of_birth, age_verified, age_verified_at)
           values ($1::uuid, $1::text, $2, $3::uuid, $4::uuid, now() - interval '1 day', true,
                   '1980-01-01', true, now())`,
          [id, email, role, t.id]
        )
      );
      const u = make(pool, email);
      const invalidated: string[] = [];
      const report = await relinkIdentities(
        {
          email,
          tenantId: t.id,
          apply: true,
          createdBefore: new Date(Date.now() - HOUR).toISOString(),
          operator: "Raman (owner)",
          osUser: "raman",
          host: "trusted-mac",
          reason: "TASK-177 proof",
        },
        {
          directory: pool.directory(),
          invalidate: async (s: string) => {
            invalidated.push(s);
            await invalidatePermissions(s);
          },
        }
      );
      expect(report.applied).toBe(true);
      expect(report.plans).toEqual([
        expect.objectContaining({
          status: "relink",
          accountId: id,
          previousSubject: id,
          newSubject: u.sub,
        }),
      ]);
      expect(await userRow(id)).toMatchObject({ id, cognito_sub: u.sub });
      expect(invalidated.sort()).toEqual([id, u.sub].sort());

      const after = await reach(t, tokenFor(u));
      expect(after.actor.actor).toMatchObject({ kind: "user", id, tenantId: t.id });
      expect(after.guarded.error).toBeUndefined();
      expect(after.guarded.actor).toMatchObject({ kind: "user", id });
      expect(after.admin.error).toBeUndefined();
      expect(after.admin.admin).toMatchObject({
        userId: id,
        sub: u.sub,
        roleName: "super_admin",
      });
      // No second account was made for the new subject.
      expect(await userRow(u.sub)).toBeUndefined();
    }
  );
});
