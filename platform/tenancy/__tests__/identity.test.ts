/**
 * @jest-environment node
 */
/**
 * platform/tenancy/__tests__/identity.test.ts — a new identity joins the tenant it signed up at
 * (ADR-053 D2)
 */

/**
 * The stored settings, as the real platform-config answers them: getConfigOrThrow throws for a
 * key it cannot read (here: one that is absent, or an Error value); getConfigBoolean never
 * throws — it answers its default, which is why signupsOpen must not rely on it.
 */
const config: Record<string, unknown> = {};
jest.mock("@/platform/auth/platform-config", () => ({
  getConfigOrThrow: jest.fn(async (k: string) => {
    const v = config[k];
    if (v === undefined) throw new Error(`Config key "${k}" unreadable: not found`);
    if (v instanceof Error) throw v;
    return v;
  }),
  getConfigBoolean: jest.fn(async (k: string, d: boolean) => {
    const v = config[k];
    return v === undefined || v instanceof Error ? d : v === true || v === "true";
  }),
}));
/** Whether a database is configured (hasDatabase). */
let db = true;
/** The tenants that hold an account for the identity; an Error makes the lookup fail. */
let accounts: string[] | Error = [];
jest.mock("@/platform/data", () => ({
  hasDatabase: () => db,
  withOwnerTx: async (_purpose: string, fn: (tx: unknown) => unknown) =>
    fn({
      query: async () => {
        if (accounts instanceof Error) throw accounts;
        return { rows: accounts.map((tenant_id) => ({ tenant_id })), rowCount: 0 };
      },
    }),
}));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import type { AuthProvider } from "@/platform/auth/provider";
import { runWithTenant } from "@/platform/tenancy/context";
import { assignCurrentTenant, ensureIdentityTenant, signupsOpen } from "../identity";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const shared = <T>(t: string, fn: () => T) =>
  runWithTenant({ tenantId: t, mode: "shared" }, fn);
let provider: AuthProvider;
let token = "";
let sub = "";

beforeEach(async () => {
  for (const k of Object.keys(config)) delete config[k];
  config.signups_enabled = true;
  db = true;
  accounts = [];
  provider = createMockAuthProvider();
  registerAuthProvider(provider);
  const s = await provider.signIn("a@b.c", "x");
  token = s.accessToken as string;
  sub = s.userId as string;
});

it("a single deployment needs nothing", async () => {
  await expect(
    runWithTenant({ tenantId: A, mode: "single" }, () => ensureIdentityTenant("anything"))
  ).resolves.toEqual({ ok: true });
  await expect(
    runWithTenant({ tenantId: A, mode: "single" }, () => assignCurrentTenant("u"))
  ).resolves.toBe(true);
});

it("a new identity is assigned the tenant of the address it signed in at", async () => {
  await expect(shared(A, () => ensureIdentityTenant(token))).resolves.toEqual({
    ok: true,
  });
  await expect(provider.getUserTenant!(sub)).resolves.toBe(A);
  // From then on it is A's: at B's address it is refused, and keeps A.
  await expect(shared(B, () => ensureIdentityTenant(token))).resolves.toEqual({
    ok: false,
    code: "tenant.mismatch",
  });
  await expect(provider.getUserTenant!(sub)).resolves.toBe(A);
  await expect(shared(A, () => ensureIdentityTenant(token))).resolves.toEqual({
    ok: true,
  });
});

it("a tenant that accepts no new accounts refuses a new identity", async () => {
  config.signups_enabled = false;
  await expect(shared(A, () => ensureIdentityTenant(token))).resolves.toEqual({
    ok: false,
    code: "auth.signups_closed",
  });
  await expect(provider.getUserTenant!(sub)).resolves.toBeNull();
});

describe("signupsOpen — fail closed", () => {
  it.each([true, "true"])("open when the stored value is %j", async (v) => {
    config.signups_enabled = v;
    await expect(signupsOpen()).resolves.toBe(true);
  });

  it.each([false, "false", "yes", 1, null, {}, "TRUE"])(
    "closed when the stored value is %j",
    async (v) => {
      config.signups_enabled = v;
      await expect(signupsOpen()).resolves.toBe(false);
    }
  );

  it("closed when the value cannot be read (the database down) or is missing", async () => {
    config.signups_enabled = new Error("connection refused");
    await expect(signupsOpen()).resolves.toBe(false);
    delete config.signups_enabled;
    await expect(signupsOpen()).resolves.toBe(false);
    // And a new identity is then refused, never assigned.
    config.signups_enabled = new Error("connection refused");
    await expect(shared(A, () => ensureIdentityTenant(token))).resolves.toEqual({
      ok: false,
      code: "auth.signups_closed",
    });
    await expect(provider.getUserTenant!(sub)).resolves.toBeNull();
  });

  it("without a database (local, E2E in-memory) the default applies: open", async () => {
    db = false;
    delete config.signups_enabled;
    await expect(signupsOpen()).resolves.toBe(true);
    config.signups_enabled = false;
    await expect(signupsOpen()).resolves.toBe(false);
  });
});

it("a token that does not verify, or an assignment that fails, is unavailable — never a session", async () => {
  await expect(shared(A, () => ensureIdentityTenant("bogus"))).resolves.toEqual({
    ok: false,
    code: "service.unavailable",
  });
  registerAuthProvider(
    createMockAuthProvider({
      assignTenant: async () => ({ success: false, error: "cognito down" }),
    })
  );
  await expect(shared(A, () => ensureIdentityTenant(token))).resolves.toEqual({
    ok: false,
    code: "service.unavailable",
  });
  registerAuthProvider(createMockAuthProvider({ assignTenant: undefined }));
  await expect(shared(A, () => assignCurrentTenant("u"))).resolves.toBe(false);
});

describe("an existing account (from before the deployment was shared)", () => {
  it("keeps its own tenant, even where sign-ups are closed", async () => {
    accounts = [A];
    config.signups_enabled = false;
    await expect(shared(A, () => ensureIdentityTenant(token))).resolves.toEqual({
      ok: true,
    });
    await expect(provider.getUserTenant!(sub)).resolves.toBe(A);
  });

  it("is refused at another tenant's address, and is not assigned there", async () => {
    accounts = [A];
    await expect(shared(B, () => ensureIdentityTenant(token))).resolves.toEqual({
      ok: false,
      code: "tenant.mismatch",
    });
    await expect(provider.getUserTenant!(sub)).resolves.toBeNull();
  });

  it("when the lookup fails, nothing is assigned: unavailable", async () => {
    accounts = new Error("database down");
    await expect(shared(A, () => ensureIdentityTenant(token))).resolves.toEqual({
      ok: false,
      code: "service.unavailable",
    });
    await expect(provider.getUserTenant!(sub)).resolves.toBeNull();
  });
});

describe("review 8 M1: a verification remembered before the tenant was assigned", () => {
  it("is voided by the assignment: the next request reads the tenant (never tenant.missing)", async () => {
    const { TokenVerifier } = await import("@/platform/auth/token-verification");
    const { getCache } = await import("@/platform/cache");
    await getCache().clear();
    // A provider like Cognito's: GetUser answers the identity's current tenant, and what it
    // answered is remembered in the shared cache.
    const tenants = new Map<string, string>();
    const verifier = new TokenVerifier();
    let asked = 0;
    const cached: AuthProvider = {
      ...createMockAuthProvider(),
      verifyToken: (t: string) =>
        verifier.verify(
          t,
          { exp: Math.floor(Date.now() / 1000) + 3600, subject: "u-1" },
          async () => {
            asked++;
            const tenantId = tenants.get("u-1");
            return {
              kind: "valid",
              payload: {
                sub: "u-1",
                email: "u@x.y",
                emailVerified: true,
                iat: 0,
                exp: Math.floor(Date.now() / 1000) + 3600,
                ...(tenantId ? { tenantId } : {}),
              },
            };
          }
        ),
      assignTenant: async (userId: string, tenantId: string) => {
        tenants.set(userId, tenantId);
        return { success: true };
      },
    };
    registerAuthProvider(cached);
    await expect(shared(A, () => ensureIdentityTenant("tok-new-user"))).resolves.toEqual({
      ok: true,
    });
    // The very next request: the tenant is there — asked again, not served from the cache.
    expect((await cached.verifyToken("tok-new-user"))?.tenantId).toBe(A);
    expect(asked).toBe(2);
    // And then remembered as usual.
    expect((await cached.verifyToken("tok-new-user"))?.tenantId).toBe(A);
    expect(asked).toBe(2);
  });

  it("a failed assignment voids nothing and is unavailable", async () => {
    registerAuthProvider({
      ...createMockAuthProvider(),
      verifyToken: async () => ({
        sub: "u-2",
        email: "",
        emailVerified: true,
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      assignTenant: async () => ({ success: false, error: "down" }),
    });
    await expect(shared(A, () => ensureIdentityTenant("t"))).resolves.toEqual({
      ok: false,
      code: "service.unavailable",
    });
  });
});
