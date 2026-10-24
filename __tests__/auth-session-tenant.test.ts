/**
 * @jest-environment node
 */
/**
 * __tests__/auth-session-tenant.test.ts — no auth route hands out a session for an identity of
 * another tenant, and every route that sets a password applies the tenant's policy
 * (ADR-053 D2; platform/tenancy/identity.ts sessionTenantRefusal, platform/auth/auth-response.ts
 * passwordPolicyRefusal).
 *
 * Shared mode, real routes, the mock identity provider (which keeps each identity's tenant as
 * Cognito's custom:tenant_id would), an in-memory tenant directory. Hostile cases: an identity
 * of tenant B completing a challenge at tenant A's address must get no tokens; a new identity
 * where A takes no new accounts must get no tokens.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req-id",
}));
// The routes use the provider registered below, not the environment's.
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));

// No database here: the identity's existing-account lookup (owner connection) finds none, so
// every identity in these tests is a new one unless its provider attribute says otherwise.
jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  withOwnerTx: async (_purpose: string, fn: (tx: unknown) => unknown) =>
    fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

/** Per-tenant settings, as platform-config would answer them in each tenant. */
const signups: Record<string, boolean> = {};
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  const { peekTenant } = jest.requireActual("@/platform/tenancy/context");
  return {
    ...actual,
    getConfigBoolean: jest.fn(async (key: string, fallback: boolean) =>
      key === "signups_enabled"
        ? (signups[peekTenant()?.tenantId ?? ""] ?? fallback)
        : fallback
    ),
  };
});

/** Each tenant's password policy, read in the tenant the request is in. */
const policies: Record<string, { minLength: number; requireSpecial: boolean }> = {};
const policyReads: (string | undefined)[] = [];
jest.mock("@/platform/auth/password-policy", () => {
  const actual = jest.requireActual("@/platform/auth/password-policy");
  const { peekTenant } = jest.requireActual("@/platform/tenancy/context");
  return {
    ...actual,
    getGlobalPasswordPolicy: jest.fn(async () => {
      const tenant = peekTenant()?.tenantId;
      policyReads.push(tenant);
      return { ...actual.DEFAULT_POLICY, ...(policies[tenant ?? ""] ?? {}) };
    }),
  };
});

import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import type { AuthProvider } from "@/platform/auth/provider";
import { resetRateLimiter } from "@/platform/rate-limit";
import {
  InMemoryTenantDirectory,
  setTenantDirectory,
} from "@/platform/tenancy/directory";
import { SSO_COOKIE, encodeSsoAttempt, randomToken } from "@/platform/auth/sso";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { POST as signUp } from "@/app/api/auth/sign-up/route";
import { POST as mfa } from "@/app/api/auth/mfa-challenge/route";
import { POST as newPassword } from "@/app/api/auth/new-password-challenge/route";
import { POST as confirmReset } from "@/app/api/auth/confirm-forgot-password/route";
import { POST as ssoCallback } from "@/app/api/auth/sso/callback/route";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
/** The mock provider's one identity. */
const SUB = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const STRONG = "Correct-Horse-Battery-9";

let provider: AuthProvider;
let ip = 0;
const savedEnv = { ...process.env };

function post(path: string, body: unknown, host = "acme.example.com", cookie?: string) {
  ip++;
  return new NextRequest(`https://${host}${path}`, {
    method: "POST",
    headers: {
      host,
      "content-type": "application/json",
      // A fresh address each time, so the routes' limits never decide a case.
      "x-forwarded-for": `198.51.100.${ip % 250}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  process.env = {
    ...savedEnv,
    TENANCY_MODE: "shared",
    TENANT_ID: "",
    TENANT_HOST_HEADER: "host",
    // For the SSO callback's feature check.
    AUTH_PROVIDER: "cognito",
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_AbC123",
    NEXT_PUBLIC_COGNITO_CLIENT_ID: "client123",
    NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: "pfx.auth.us-east-1.amazoncognito.com",
    SSO_PROVIDERS: "google",
  };
  for (const k of Object.keys(signups)) delete signups[k];
  for (const k of Object.keys(policies)) delete policies[k];
  policyReads.length = 0;
  const directory = new InMemoryTenantDirectory({ withDefault: false });
  await directory.createTenant({ id: A, slug: "acme", name: "Acme" });
  await directory.createTenant({ id: B, slug: "beta", name: "Beta" });
  await directory.addDomain(A, "acme.example.com");
  await directory.addDomain(B, "beta.example.com");
  setTenantDirectory(directory);
  provider = createMockAuthProvider({
    // The callback's exchange, ending in the same session as sign-in.
    handleSsoCallback: async () => ({
      success: true,
      userId: SUB,
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
      expiresIn: 3600,
    }),
  });
  registerAuthProvider(provider);
  resetRateLimiter();
});

afterAll(() => {
  process.env = savedEnv;
});

function ssoRequest(host = "acme.example.com") {
  const state = randomToken();
  const cookie = `${SSO_COOKIE}=${encodeSsoAttempt({
    provider: "google",
    state,
    verifier: randomToken(),
  })}`;
  return post("/api/auth/sso/callback", { code: "the-code", state }, host, cookie);
}

/** Each route that can end in a session, called at `host`. */
const SESSION_ROUTES: Record<string, (host?: string) => Promise<Response>> = {
  "sign-in": (host) =>
    signIn(post("/api/auth/sign-in", { email: "a@b.c", password: "x" }, host)),
  "mfa-challenge": (host) =>
    mfa(post("/api/auth/mfa-challenge", { session: "s", code: "123456" }, host)),
  "new-password-challenge": (host) =>
    newPassword(
      post(
        "/api/auth/new-password-challenge",
        { session: "s", newPassword: STRONG, username: "a@b.c" },
        host
      )
    ),
  "sso/callback": (host) => ssoCallback(ssoRequest(host)),
};

function expectNoSession(body: Record<string, unknown>) {
  expect(body.accessToken).toBeUndefined();
  expect(body.refreshToken).toBeUndefined();
  expect(body.idToken).toBeUndefined();
  expect(JSON.stringify(body)).not.toMatch(/mock-(access|refresh)-token/);
}

describe.each(Object.entries(SESSION_ROUTES))(
  "%s in a shared deployment",
  (_name, call) => {
    it("an identity of another tenant is refused tenant.mismatch, with no tokens", async () => {
      await provider.assignTenant!(SUB, B);
      const res = await call("acme.example.com");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("tenant.mismatch");
      expectNoSession(body);
      await expect(provider.getUserTenant!(SUB)).resolves.toBe(B); // and it stays B's
    });

    it("a new identity is assigned the address's tenant and gets its session", async () => {
      const res = await call("acme.example.com");
      expect(res.status).toBe(200);
      expect((await res.json()).accessToken).toBe("mock-access-token");
      await expect(provider.getUserTenant!(SUB)).resolves.toBe(A);
    });

    it("a new identity where the tenant takes no new accounts is refused, with no tokens", async () => {
      signups[A] = false;
      const res = await call("acme.example.com");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("auth.signups_closed");
      expectNoSession(body);
      await expect(provider.getUserTenant!(SUB)).resolves.toBeNull();
    });

    it("when the identity cannot be checked, the session is not returned (503)", async () => {
      registerAuthProvider({ ...provider, verifyToken: async () => null });
      const res = await call("acme.example.com");
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("service.unavailable");
      expectNoSession(body);
    });

    it("an identity of the address's own tenant gets its session", async () => {
      await provider.assignTenant!(SUB, A);
      const res = await call("acme.example.com");
      expect(res.status).toBe(200);
      expect((await res.json()).accessToken).toBe("mock-access-token");
    });
  }
);

describe("a session with no access token to check", () => {
  it("is refused in a shared deployment, never handed out unchecked", async () => {
    registerAuthProvider({
      ...provider,
      respondToMfaChallenge: async () => ({
        success: true,
        userId: SUB,
        refreshToken: "mock-refresh-token",
      }),
    });
    const res = await SESSION_ROUTES["mfa-challenge"]();
    expect(res.status).toBe(503);
    expectNoSession(await res.json());
  });
});

describe("sign-up", () => {
  it("a provider that signs the new account straight in is checked like sign-in", async () => {
    await provider.assignTenant!(SUB, B);
    registerAuthProvider({
      ...provider,
      assignTenant: async () => ({ success: true }), // B's identity is not moved
      signUp: async () => ({
        success: true,
        userId: SUB,
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
      }),
    });
    const res = await signUp(
      post("/api/auth/sign-up", { email: "a@b.c", password: STRONG })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("tenant.mismatch");
    expectNoSession(body);
  });

  it("an ordinary sign-up (no session) is unchanged", async () => {
    const res = await signUp(
      post("/api/auth/sign-up", { email: "a@b.c", password: STRONG })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      emailVerificationRequired: true,
    });
    await expect(provider.getUserTenant!(SUB)).resolves.toBe(A);
  });
});

/** Each route that sets a password, with `password`, at `host`. */
const PASSWORD_ROUTES: Record<
  string,
  (password: string, host?: string) => Promise<Response>
> = {
  "sign-up": (password, host) =>
    signUp(post("/api/auth/sign-up", { email: "a@b.c", password }, host)),
  "confirm-forgot-password": (password, host) =>
    confirmReset(
      post(
        "/api/auth/confirm-forgot-password",
        { email: "a@b.c", code: "123456", newPassword: password },
        host
      )
    ),
  "new-password-challenge": (password, host) =>
    newPassword(
      post(
        "/api/auth/new-password-challenge",
        { session: "s", newPassword: password, username: "a@b.c" },
        host
      )
    ),
};

describe.each(Object.entries(PASSWORD_ROUTES))(
  "%s applies the tenant's password policy",
  (_name, call) => {
    it("a password the tenant's policy refuses never reaches the provider", async () => {
      const spies = [
        jest.spyOn(provider, "signUp"),
        jest.spyOn(provider, "confirmForgotPassword"),
        jest.spyOn(provider, "respondToNewPasswordChallenge"),
      ];
      policies[A] = { minLength: 30, requireSpecial: true };
      const res = await call(STRONG, "acme.example.com");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("auth.password_policy");
      expect(body.params.rules).toEqual(["min_length"]);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(policyReads).toEqual([A]); // read in the request's tenant
    });

    it("another tenant's stricter policy does not apply here", async () => {
      policies[B] = { minLength: 30, requireSpecial: true };
      const res = await call(STRONG, "acme.example.com");
      expect(res.status).toBe(200);
      expect(policyReads).toEqual([A]);
    });

    it("the default policy refuses an obviously weak password", async () => {
      const res = await call("short", "acme.example.com");
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("auth.password_policy");
    });
  }
);
