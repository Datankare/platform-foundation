/**
 * @jest-environment node
 */
/**
 * users.email_verified kept in step with the identity provider (TASK-176,
 * platform/auth/email-verification.ts), against the replayed Postgres: an account made by sign-up
 * (stored unverified), confirmed and then signed in, is marked verified by its first request —
 * once, with one audit record, and never written again; an unverified claim, another address, a
 * provider that cannot answer, and concurrent requests change nothing they must not.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-email-verified",
}));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { withOwnerTx } from "@/platform/data";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import type { AuthProvider } from "@/platform/auth/provider";
import type { TokenPayload } from "@/platform/auth/types";
import { TokenVerificationUnavailableError } from "@/platform/auth/token-verification";
import { clearConfigCache } from "@/platform/auth/platform-config";
import { clearPermissionsCache } from "@/platform/auth/permissions-cache";
import { requireActor } from "@/platform/auth/middleware";
import { ensureUserProvisioned } from "@/platform/auth/user-provisioning";
import { runRequestScope } from "@/platform/tenancy/context";
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

type Row = Record<string, unknown>;

let a: TestTenant;
let tokens = new Map<string, TokenPayload | "unavailable">();
const run = randomUUID().slice(0, 8);
let n = 0;
const address = (label: string) => `${label}.${run}.${++n}@verify176.example`;

function signInAs(sub: string, over: Partial<TokenPayload> = {}): string {
  const token = `tok-${randomUUID()}`;
  tokens.set(token, {
    sub,
    email: "",
    emailVerified: true,
    // A native user: the pool itself verified the address (review 16 L8).
    identityProviders: [],
    iat: 0,
    exp: Math.floor(Date.now() / 1000) + 600,
    tenantId: a.id,
    ...over,
  });
  return token;
}

const httpRequest = (token: string) =>
  new NextRequest("http://localhost/api/x", {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" },
  });

const saved = { mode: process.env.TENANCY_MODE, tenant: process.env.TENANT_ID };
/** One request of a single-tenant deployment of `a` (the scope tenantRoute gives a route). */
async function request(token: string) {
  delete process.env.TENANCY_MODE;
  process.env.TENANT_ID = a.id;
  try {
    return await runRequestScope(() =>
      requireActor(httpRequest(token), { allowGuests: false })
    );
  } finally {
    if (saved.mode === undefined) delete process.env.TENANCY_MODE;
    else process.env.TENANCY_MODE = saved.mode;
    if (saved.tenant === undefined) delete process.env.TENANT_ID;
    else process.env.TENANT_ID = saved.tenant;
  }
}

/** What POST /api/auth/sign-up stores: the row, with the typed address, unverified. */
async function signUp(email: string): Promise<string> {
  const sub = randomUUID();
  await expect(a.run(() => ensureUserProvisioned(sub, { email }))).resolves.toBe(
    "created"
  );
  return sub;
}

const row = async (id: string): Promise<Row> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "select email, email_verified, xmin::text as version from users where id = $1::uuid",
        [id]
      )
    )
  ).rows[0]!;

const addressAudit = async (id: string): Promise<Row[]> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        `select actor_id, target_id, details from audit_log
          where target_id = $1::uuid and action = 'profile_updated'::audit_action
            and details->>'field' = 'email'`,
        [id]
      )
    )
  ).rows;

const setStatus = (id: string, status: string) =>
  withOwnerTx("operator", (tx) =>
    tx.query("update users set account_status = $2::account_status where id = $1::uuid", [
      id,
      status,
    ])
  );

const statusOf = async (id: string): Promise<Row> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "select account_status, ban_reason, status_changed_by from users where id = $1::uuid",
        [id]
      )
    )
  ).rows[0]!;

/** An account provisioned by a first request that carried no address (TASK-185's defect). */
async function provisionedWithoutAddress(): Promise<string> {
  const sub = randomUUID();
  await expect(a.run(() => ensureUserProvisioned(sub))).resolves.toBe("created");
  expect(await row(sub)).toMatchObject({ email: null, email_verified: false });
  return sub;
}

const verificationAudit = async (id: string): Promise<Row[]> =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query(
        `select actor_id, target_id, details from audit_log
          where target_id = $1::uuid and action = 'profile_updated'::audit_action
            and details->>'field' = 'email_verified'`,
        [id]
      )
    )
  ).rows;

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    const base = createMockAuthProvider();
    const provider: AuthProvider = {
      ...base,
      verifyToken: async (t: string) => {
        const p = tokens.get(t);
        // GetUser throttled or down, with no remembered answer (token-verification.ts).
        if (p === "unavailable") throw new TokenVerificationUnavailableError("Throttled");
        return p ?? null;
      },
      getUserTenant: async () => a.id,
    };
    registerAuthProvider(provider);
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

beforeEach(async () => {
  tokens = new Map();
  clearConfigCache();
  await clearPermissionsCache();
  resetRateLimiter();
});

dbDescribe("TASK-176: users.email_verified follows the provider's verified claim", () => {
  it("sign-up, confirm, sign in: the first request marks it verified with one audit record; later requests write nothing", async () => {
    const email = address("confirmed");
    const sub = await signUp(email);
    expect(await row(sub)).toMatchObject({ email, email_verified: false });

    // Confirmed with the code, signed in: GetUser now says email_verified true for the address.
    const token = signInAs(sub, { email, emailVerified: true });
    const first = await request(token);
    expect(first.actor).toMatchObject({ kind: "user", id: sub });
    const after = await row(sub);
    expect(after).toMatchObject({ email_verified: true });
    const records = await verificationAudit(sub);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actor_id: sub,
      target_id: sub,
      details: {
        field: "email_verified",
        from: false,
        to: true,
        source: "identity_provider",
      },
    });

    // Every request after: compared, never written (the row's version is unchanged).
    for (let i = 0; i < 3; i++) expect((await request(token)).actor).toBeDefined();
    expect(await row(sub)).toEqual(after);
    expect(await verificationAudit(sub)).toHaveLength(1);
  });

  it("the address as typed differs only in case and surrounding space: still the same address", async () => {
    const email = address("case");
    const sub = await signUp(email);
    await request(
      signInAs(sub, { email: `  ${email.toUpperCase()} `, emailVerified: true })
    );
    expect(await row(sub)).toMatchObject({ email, email_verified: true });
  });

  it("an unverified claim changes nothing", async () => {
    const email = address("unverified");
    const sub = await signUp(email);
    const before = await row(sub);
    const r = await request(signInAs(sub, { email, emailVerified: false }));
    expect(r.actor).toBeDefined();
    expect(await row(sub)).toEqual(before);
    expect(await verificationAudit(sub)).toEqual([]);
  });

  it("TASK-185: a verified claim of ANOTHER address on an active account is recorded, verified, once", async () => {
    const email = address("old");
    const sub = await signUp(email);
    const moved = address("new");
    const token = signInAs(sub, {
      email: moved,
      emailVerified: true,
      addressFresh: true,
    });
    await request(token);
    const after = await row(sub);
    expect(after).toMatchObject({ email: moved, email_verified: true });
    expect(await addressAudit(sub)).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ field: "email", change: "changed" }),
      }),
    ]);
    // The address itself is never in the record.
    expect(JSON.stringify(await addressAudit(sub))).not.toContain(moved);
    await request(token);
    expect(await row(sub)).toEqual(after);
  });

  it("TASK-185: two devices with different remembered answers never flip it — only a fresh answer moves it", async () => {
    const x = address("device-x");
    const y = address("device-y");
    const sub = await signUp(x);
    // Device A: the provider's own answer now, address x (the stored one): marked verified.
    await request(signInAs(sub, { email: x, emailVerified: true, addressFresh: true }));
    expect(await row(sub)).toMatchObject({ email: x, email_verified: true });
    // Device B: a remembered answer from before the change, address y: nothing moves.
    const before = await row(sub);
    for (let i = 0; i < 3; i++) {
      await request(signInAs(sub, { email: y, emailVerified: true }));
      await request(signInAs(sub, { email: x, emailVerified: true }));
    }
    expect(await row(sub)).toEqual(before);
    expect(await addressAudit(sub)).toEqual([]);
    // The provider's own answer says y: it moves, once.
    await request(signInAs(sub, { email: y, emailVerified: true, addressFresh: true }));
    expect(await row(sub)).toMatchObject({ email: y });
    // And device A's remembered x does not move it back.
    await request(signInAs(sub, { email: x, emailVerified: true }));
    expect(await row(sub)).toMatchObject({ email: y });
    expect(await addressAudit(sub)).toHaveLength(1);
  });

  it("TASK-185: a banned account's address is never moved — the ban stays with it", async () => {
    const email = address("banned-old");
    const sub = await signUp(email);
    await setStatus(sub, "banned");
    const before = await row(sub);
    await request(
      signInAs(sub, { email: address("escape"), emailVerified: true, addressFresh: true })
    );
    expect(await row(sub)).toEqual(before);
    expect(await addressAudit(sub)).toEqual([]);
  });

  it("TASK-185: a suspended account keeps its address until it is active again", async () => {
    const email = address("suspended");
    const sub = await signUp(email);
    await setStatus(sub, "suspended");
    const before = await row(sub);
    await request(
      signInAs(sub, {
        email: address("elsewhere"),
        emailVerified: true,
        addressFresh: true,
      })
    );
    expect(await row(sub)).toEqual(before);
  });

  it("a provider that cannot answer: the request is refused (503) and the row is unchanged", async () => {
    const email = address("transient");
    const sub = await signUp(email);
    const before = await row(sub);
    const token = `tok-${randomUUID()}`;
    tokens.set(token, "unavailable");
    const r = await request(token);
    expect(r.error?.status).toBe(503);
    expect(await row(sub)).toEqual(before);
  });

  it("never downgraded: a verified account given an unverified claim stays verified", async () => {
    const email = address("down");
    const sub = await signUp(email);
    await request(signInAs(sub, { email, emailVerified: true }));
    const verified = await row(sub);
    expect(verified).toMatchObject({ email_verified: true });
    await request(signInAs(sub, { email, emailVerified: false }));
    await request(signInAs(sub, { email: "", emailVerified: false }));
    expect(await row(sub)).toEqual(verified);
    expect(await verificationAudit(sub)).toHaveLength(1);
  });

  it("concurrent first requests: one change, one audit record", async () => {
    const email = address("race");
    const sub = await signUp(email);
    const token = signInAs(sub, { email, emailVerified: true });
    const results = await Promise.all(Array.from({ length: 6 }, () => request(token)));
    for (const r of results) expect(r.actor).toBeDefined();
    expect(await row(sub)).toMatchObject({ email_verified: true });
    expect(await verificationAudit(sub)).toHaveLength(1);
  });

  it("review 16 L8: a federated user's claim marks it verified only from an allow-listed provider (Google by default) — never Entra ID, never an unsaid source", async () => {
    const google = address("google");
    const gSub = await signUp(google);
    await request(
      signInAs(gSub, {
        email: google,
        emailVerified: true,
        identityProviders: ["Google"],
      })
    );
    expect(await row(gSub)).toMatchObject({ email_verified: true });
    expect((await verificationAudit(gSub))[0]).toMatchObject({
      details: { verifiedBy: "Google" },
    });

    for (const [label, over] of [
      ["entra", { identityProviders: ["EntraID"] }],
      ["mixed", { identityProviders: ["Google", "EntraID"] }],
      ["unsaid", { identityProviders: undefined }],
    ] as const) {
      const email = address(label);
      const sub = await signUp(email);
      const before = await row(sub);
      const r = await request(signInAs(sub, { email, emailVerified: true, ...over }));
      expect(r.actor).toBeDefined();
      expect(await row(sub)).toEqual(before);
      expect(await verificationAudit(sub)).toEqual([]);
    }

    // The allow-list is the deployment's: Entra ID only when listed explicitly.
    const saved = process.env.AUTH_TRUSTED_EMAIL_IDPS;
    process.env.AUTH_TRUSTED_EMAIL_IDPS = "Google,EntraID";
    try {
      const email = address("listed");
      const sub = await signUp(email);
      await request(
        signInAs(sub, { email, emailVerified: true, identityProviders: ["EntraID"] })
      );
      expect(await row(sub)).toMatchObject({ email_verified: true });
    } finally {
      if (saved === undefined) delete process.env.AUTH_TRUSTED_EMAIL_IDPS;
      else process.env.AUTH_TRUSTED_EMAIL_IDPS = saved;
    }
  });

  it("an account provisioned by its first request from a verified claim is verified from the start (no change to record)", async () => {
    const email = address("first");
    const sub = randomUUID();
    await expect(
      a.run(() => ensureUserProvisioned(sub, { email, emailVerified: true }))
    ).resolves.toBe("created");
    await request(signInAs(sub, { email, emailVerified: true }));
    expect(await row(sub)).toMatchObject({ email_verified: true });
    expect(await verificationAudit(sub)).toEqual([]);
  });
});

dbDescribe("TASK-185: users.email recorded from the provider's verified claim", () => {
  it("an account with no address gets the verified one on its next request — once, audited, as stored", async () => {
    const sub = await provisionedWithoutAddress();
    const email = address("filled");
    const token = signInAs(sub, {
      email: `  ${email.toUpperCase()} `,
      emailVerified: true,
    });
    expect((await request(token)).actor).toMatchObject({ kind: "user", id: sub });
    const after = await row(sub);
    expect(after).toMatchObject({ email, email_verified: true });
    expect(await addressAudit(sub)).toEqual([
      expect.objectContaining({
        actor_id: sub,
        target_id: sub,
        details: expect.objectContaining({
          field: "email",
          change: "absent",
          source: "identity_provider",
          verifiedBy: "pool",
        }),
      }),
    ]);
    for (let i = 0; i < 3; i++) await request(token);
    expect(await row(sub)).toEqual(after);
    expect(await addressAudit(sub)).toHaveLength(1);
  });

  it("never from an unverified claim, an untrusted provider, or a token that does not say", async () => {
    for (const over of [
      { emailVerified: false, identityProviders: [] },
      { emailVerified: true, identityProviders: ["EntraID"] },
      { emailVerified: true, identityProviders: ["Google", "Facebook"] },
      { emailVerified: true, identityProviders: undefined },
    ]) {
      const sub = await provisionedWithoutAddress();
      const before = await row(sub);
      const r = await request(signInAs(sub, { email: address("nope"), ...over }));
      expect(r.actor).toBeDefined();
      expect(await row(sub)).toEqual(before);
      expect(await addressAudit(sub)).toEqual([]);
    }
  });

  it("an unverified or untrusted provider never overwrites a stored address", async () => {
    const email = address("kept");
    const sub = await signUp(email);
    await request(signInAs(sub, { email, emailVerified: true }));
    const verified = await row(sub);
    for (const over of [
      { emailVerified: false, identityProviders: [], addressFresh: true },
      { emailVerified: true, identityProviders: ["EntraID"], addressFresh: true },
    ])
      await request(signInAs(sub, { email: address("attacker"), ...over }));
    expect(await row(sub)).toEqual(verified);
    expect(await addressAudit(sub)).toEqual([]);
  });

  it("a Google sign-in (allow-listed) fills it, and says who verified it", async () => {
    const sub = await provisionedWithoutAddress();
    const email = address("google-fill");
    await request(
      signInAs(sub, { email, emailVerified: true, identityProviders: ["Google"] })
    );
    expect(await row(sub)).toMatchObject({ email, email_verified: true });
    expect((await addressAudit(sub))[0]).toMatchObject({
      details: { verifiedBy: "Google" },
    });
  });

  it("A-11: a recorded address that a banned account holds bans this one too", async () => {
    const bannedAddress = address("banned-holder");
    const holder = await signUp(bannedAddress);
    await setStatus(holder, "banned");
    const sub = await provisionedWithoutAddress();
    await request(signInAs(sub, { email: bannedAddress, emailVerified: true }));
    expect(await row(sub)).toMatchObject({ email: bannedAddress, email_verified: true });
    expect(await statusOf(sub)).toMatchObject({
      account_status: "banned",
      status_changed_by: "platform:ban-carry-over",
    });
    expect((await addressAudit(sub))[0]).toMatchObject({
      details: { banCarriedOver: true },
    });
  });

  it("concurrent first requests: one change, one audit record", async () => {
    const sub = await provisionedWithoutAddress();
    const token = signInAs(sub, { email: address("race-fill"), emailVerified: true });
    const results = await Promise.all(Array.from({ length: 6 }, () => request(token)));
    for (const r of results) expect(r.actor).toBeDefined();
    expect(await addressAudit(sub)).toHaveLength(1);
  });

  it("an erased (soft-deleted) account is never written", async () => {
    const sub = await provisionedWithoutAddress();
    await withOwnerTx("operator", (tx) =>
      tx.query("update users set deleted_at = now() where id = $1::uuid", [sub])
    );
    const before = await row(sub);
    await request(signInAs(sub, { email: address("erased"), emailVerified: true }));
    expect(await row(sub)).toEqual(before);
  });
});

dbDescribe("TASK-185: the last sign-in", () => {
  const lastLogin = async (id: string) =>
    (
      await withOwnerTx("operator", (tx) =>
        tx.query<{ last_login_at: Date | null }>(
          "select last_login_at from users where id = $1::uuid",
          [id]
        )
      )
    ).rows[0]!.last_login_at;

  it("a first sign-in, recorded before the row existed, is the new account's last sign-in", async () => {
    const sub = randomUUID();
    const at = "2026-10-20T08:30:00Z";
    await withOwnerTx("operator", (tx) =>
      tx.query(
        `insert into audit_log (tenant_id, action, actor_id, details, created_at) values
           ($1::uuid, 'login_success', $2::uuid, '{"method":"password"}', $3::timestamptz),
           ($1::uuid, 'login_success', $2::uuid, '{"method":"refresh"}', now())`,
        [a.id, sub, at]
      )
    );
    await a.run(() => ensureUserProvisioned(sub, { email: address("first-login") }));
    expect((await lastLogin(sub))?.toISOString()).toBe("2026-10-20T08:30:00.000Z");
  });

  it("each sign-in sets it; a refresh, an unknown account and a deleted one do not", async () => {
    const { recordLastSignIn } = await import("@/platform/auth/auth-events");
    const sub = await signUp(address("signs-in"));
    expect(await lastLogin(sub)).toBeNull();
    await a.run(() => recordLastSignIn(sub, "refresh"));
    expect(await lastLogin(sub)).toBeNull();
    await a.run(() => recordLastSignIn(sub, "password"));
    const first = await lastLogin(sub);
    expect(first).not.toBeNull();
    await a.run(() => recordLastSignIn(undefined, "password"));
    await a.run(() => recordLastSignIn(randomUUID(), "sso"));
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "update users set deleted_at = now(), last_login_at = null where id = $1::uuid",
        [sub]
      )
    );
    await a.run(() => recordLastSignIn(sub, "mfa"));
    expect(await lastLogin(sub)).toBeNull();
  });
});
