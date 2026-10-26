/**
 * __tests__/r17-hostile-cognito.test.ts — review 17 L1–L4, the reviewer's proofs kept as
 * regression tests, with the pool-shape check and its readiness probe.
 *
 *   L1  a GetUser answer without `sub` is invalid, and its Username is never remembered for the
 *       administrative calls;
 *   L2  the native-user rule needs `identities` readable: once checkPoolShape found it hidden, no
 *       user is native for want of it; a native user linked to a federated identity
 *       (AdminLinkProviderForUser) is not native; the probe degrades;
 *   L3  AUTH_TRUSTED_EMAIL_IDPS matches case-insensitively and trims around commas;
 *   L4  a pool that signs in by username is refused at readiness (the probe is unhealthy).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { getCache } from "@/platform/cache";
import {
  CognitoAuthProvider,
  POOL_SHAPE_OPERATOR_CHECK,
  identityProvidersFrom,
} from "@/platform/auth/cognito-provider";
import type { CognitoConfig } from "@/platform/auth/cognito-provider";
import { trustedVerifiedClaim } from "@/platform/auth/email-verification";
import { getTrustedEmailIdps } from "@/platform/providers/environment-contract";
import { parseArgs } from "@/platform/auth/identity-relink-command";
import {
  POOL_SHAPE_PROBE,
  createPoolShapeProbe,
  poolShapeStatus,
} from "@/platform/auth/pool-shape-probe";
import type { PoolShapeReadiness } from "@/platform/auth/provider";
import { TEST_JWKS, signJwt } from "./helpers/test-jwt";

const TEST_CONFIG: CognitoConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  timeoutMs: 5000,
  jwks: TEST_JWKS,
};
const ADMIN: CognitoConfig = {
  ...TEST_CONFIG,
  adminCredentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s".repeat(40) },
};

const SUB = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const TENANT = "00000000-0000-4000-8000-0000000000aa";

const originalFetch = global.fetch;
let mockFetch: jest.Mock;
beforeEach(() => getCache().clear());
beforeEach(() => {
  mockFetch = jest.fn();
  global.fetch = mockFetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const ok = (body: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const fail = (type: string) => ({
  ok: false,
  status: 400,
  json: async () => ({ __type: type, message: type }),
});

function accessJwt(extra: Record<string, unknown> = {}): string {
  return signJwt({
    sub: SUB,
    token_use: "access",
    client_id: TEST_CONFIG.clientId,
    iss: `https://cognito-idp.${TEST_CONFIG.region}.amazonaws.com/${TEST_CONFIG.userPoolId}`,
    iat: 1000,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  });
}

function targetOf(n: number): string | undefined {
  const headers = (mockFetch.mock.calls[n][1] as RequestInit).headers as Record<
    string,
    string
  >;
  return Object.entries(headers)
    .find(([k]) => k.toLowerCase() === "x-amz-target")?.[1]
    ?.split(".")
    .pop();
}

const NATIVE_ATTRS = [
  { Name: "sub", Value: SUB },
  { Name: "email", Value: "v@corp.example" },
  { Name: "email_verified", Value: "true" },
];

describe("review 17 L1: a GetUser answer without sub", () => {
  it("is invalid, and its Username is never remembered for administrative calls", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        Username: "Google_999",
        UserAttributes: [
          { Name: "email", Value: "x@y.z" },
          { Name: "email_verified", Value: "true" },
        ],
      })
    );
    const p = new CognitoAuthProvider(ADMIN);
    expect(await p.verifyToken(accessJwt())).toBeNull();
    mockFetch.mockResolvedValueOnce(ok({}));
    await p.assignTenant(SUB, TENANT);
    expect(targetOf(1)).toBe("AdminUpdateUserAttributes");
    // Addressed by the sub (a native user's username), never the answer's unproven Username.
    expect(JSON.parse(String(mockFetch.mock.calls[1][1].body)).Username).toBe(SUB);
  });

  it("an answer naming another sub is invalid too; its Username is not remembered", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        Username: "Google_999",
        UserAttributes: [{ Name: "sub", Value: "00000000-0000-4000-8000-000000000000" }],
      })
    );
    const p = new CognitoAuthProvider(ADMIN);
    expect(await p.verifyToken(accessJwt())).toBeNull();
    mockFetch.mockResolvedValueOnce(ok({}));
    await p.assignTenant(SUB, TENANT);
    expect(JSON.parse(String(mockFetch.mock.calls[1][1].body)).Username).toBe(SUB);
  });
});

describe("review 17 L2: the native-user rule", () => {
  it("Username === sub with identities hidden from the app client: not native once that is known", () => {
    // Not yet checked: the documented pool shape is assumed (the probe reports otherwise).
    expect(identityProvidersFrom(SUB, NATIVE_ATTRS)).toEqual({ identityProviders: [] });
    const hidden = identityProvidersFrom(SUB, NATIVE_ATTRS, false);
    expect(hidden).toEqual({});
    expect(
      trustedVerifiedClaim({ email: "v@corp.example", emailVerified: true, ...hidden })
    ).toBe(false);
    expect(identityProvidersFrom(SUB, NATIVE_ATTRS, true)).toEqual({
      identityProviders: [],
    });
  });

  it("a native user linked to a federated identity (AdminLinkProviderForUser) is not native", () => {
    const linked = (providerName: string) => [
      ...NATIVE_ATTRS,
      { Name: "identities", Value: JSON.stringify([{ providerName, userId: "1" }]) },
    ];
    expect(identityProvidersFrom(SUB, linked("EntraID"))).toEqual({
      identityProviders: ["EntraID"],
    });
    expect(
      trustedVerifiedClaim({
        emailVerified: true,
        ...identityProvidersFrom(SUB, linked("EntraID")),
      })
    ).toBe(false);
    expect(identityProvidersFrom(SUB, linked("Google"), true)).toEqual({
      identityProviders: ["Google"],
    });
  });

  it("verifyToken stops taking users as native once checkPoolShape found identities hidden", async () => {
    const p = new CognitoAuthProvider(ADMIN);
    mockFetch
      .mockResolvedValueOnce(ok({ UserPool: { UsernameAttributes: ["email"] } }))
      .mockResolvedValueOnce(
        ok({ UserPoolClient: { ReadAttributes: ["email", "email_verified"] } })
      );
    expect(await p.checkPoolShape()).toMatchObject({
      state: "unsafe",
      cause: "identities_hidden",
    });
    expect(targetOf(0)).toBe("DescribeUserPool");
    expect(targetOf(1)).toBe("DescribeUserPoolClient");
    expect(JSON.parse(String(mockFetch.mock.calls[1][1].body))).toEqual({
      UserPoolId: TEST_CONFIG.userPoolId,
      ClientId: TEST_CONFIG.clientId,
    });
    mockFetch.mockResolvedValueOnce(ok({ Username: SUB, UserAttributes: NATIVE_ATTRS }));
    const payload = await p.verifyToken(accessJwt({ username: SUB }));
    expect(payload).toMatchObject({ sub: SUB, emailVerified: true });
    expect(payload).not.toHaveProperty("identityProviders");
  });
});

describe("review 17 L2/L4: checkPoolShape", () => {
  const shape = async (pool: unknown, client: unknown) => {
    mockFetch
      .mockResolvedValueOnce(ok({ UserPool: pool }))
      .mockResolvedValueOnce(ok({ UserPoolClient: client }));
    return new CognitoAuthProvider(ADMIN).checkPoolShape();
  };

  it.each([
    ["every attribute readable (no ReadAttributes)", {}],
    ["identities among the readable attributes", { ReadAttributes: ["identities"] }],
  ])("ready: sign-in by email address, %s", async (_l, client) => {
    expect(await shape({ UsernameAttributes: ["email"] }, client)).toEqual({
      state: "ready",
    });
    expect(
      await shape({ UsernameAttributes: ["email", "phone_number"] }, client)
    ).toEqual({ state: "ready" });
  });

  it.each([
    ["no UsernameAttributes", {}],
    ["phone number only", { UsernameAttributes: ["phone_number"] }],
    ["username with an email alias", { AliasAttributes: ["email"] }],
  ])("unsafe: the pool signs in by username (%s)", async (_l, pool) => {
    expect(await shape(pool, {})).toMatchObject({
      state: "unsafe",
      cause: "username_sign_in",
    });
  });

  it("unknown without administrative credentials, naming the operator's check — and no call", async () => {
    const r = await new CognitoAuthProvider(TEST_CONFIG).checkPoolShape();
    expect(r).toMatchObject({ state: "unknown", cause: "no_credentials" });
    expect(r.state !== "ready" && r.reason).toContain(POOL_SHAPE_OPERATOR_CHECK);
    expect(POOL_SHAPE_OPERATOR_CHECK).toContain("describe-user-pool-client");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("unknown when the pool does not answer", async () => {
    mockFetch.mockResolvedValueOnce(fail("AccessDeniedException"));
    expect(await new CognitoAuthProvider(ADMIN).checkPoolShape()).toMatchObject({
      state: "unknown",
      cause: "unavailable",
      reason: expect.stringContaining("AccessDeniedException"),
    });
  });
});

describe("review 17 L2/L4: the readiness probe", () => {
  it.each<[PoolShapeReadiness | null, string]>([
    [{ state: "ready" }, "healthy"],
    [null, "healthy"],
    [{ state: "unsafe", cause: "username_sign_in", reason: "r" }, "unhealthy"],
    [{ state: "unsafe", cause: "identities_hidden", reason: "r" }, "degraded"],
    [{ state: "unknown", cause: "unavailable", reason: "r" }, "degraded"],
    [{ state: "unknown", cause: "no_credentials", reason: "r" }, "healthy"],
  ])("%p → %s", (result, status) => {
    expect(poolShapeStatus(result).status).toBe(status);
  });

  it("keeps a definite answer, asks again after an unavailable one, and says once when it cannot check", async () => {
    const { logger } = jest.requireMock("@/lib/logger");
    let now = 0;
    const check = jest
      .fn<Promise<PoolShapeReadiness | null>, []>()
      .mockResolvedValueOnce({ state: "unknown", cause: "unavailable", reason: "down" })
      .mockResolvedValueOnce({ state: "ready" });
    const probe = createPoolShapeProbe({ check, now: () => now });
    expect(probe.name).toBe(POOL_SHAPE_PROBE);
    expect((await probe.check()).status).toBe("degraded");
    now = 30_000;
    expect((await probe.check()).status).toBe("degraded");
    expect(check).toHaveBeenCalledTimes(1);
    now = 61_000;
    expect((await probe.check()).status).toBe("healthy");
    now = 5 * 60_000;
    await probe.check();
    expect(check).toHaveBeenCalledTimes(2);

    (logger.warn as jest.Mock).mockClear();
    const blind = createPoolShapeProbe({
      check: async () => ({
        state: "unknown",
        cause: "no_credentials",
        reason: "check it",
      }),
      now: () => now,
    });
    await blind.check();
    now += 11 * 60_000;
    await blind.check();
    expect(
      (logger.warn as jest.Mock).mock.calls.filter(([m]) => /check it by hand/.test(m))
    ).toHaveLength(1);
  });

  it("a slow pool is bounded (degraded, never a hung readiness); a throwing check is degraded", async () => {
    const slow = createPoolShapeProbe({
      check: () => new Promise(() => undefined),
      budgetMs: 10,
    });
    expect(await slow.check()).toMatchObject({
      status: "degraded",
      detail: expect.stringContaining("did not answer"),
    });
    const throws = createPoolShapeProbe({
      check: async () => {
        throw new TypeError("x");
      },
    });
    expect((await throws.check()).status).toBe("degraded");
  });
});

describe("review 17 L3: AUTH_TRUSTED_EMAIL_IDPS", () => {
  it("google (lower case, as SSO_PROVIDERS spells it) trusts the pool's Google users", () => {
    const t = getTrustedEmailIdps({ AUTH_TRUSTED_EMAIL_IDPS: "google" });
    expect(
      trustedVerifiedClaim({ emailVerified: true, identityProviders: ["Google"] }, t)
    ).toBe(true);
  });

  it("'Google, SignInWithApple' (a space after the comma) trusts both", () => {
    const spaced = getTrustedEmailIdps({
      AUTH_TRUSTED_EMAIL_IDPS: "Google, SignInWithApple",
    });
    expect(spaced.size).toBe(2);
    expect(
      trustedVerifiedClaim(
        { emailVerified: true, identityProviders: ["SignInWithApple"] },
        spaced
      )
    ).toBe(true);
  });
});

describe("review 17: --subject parsing (unchanged)", () => {
  it("refuses username or a malformed value; accepts sub with a note", () => {
    expect(() => parseArgs(["--subject", "username", "--email", "a@b.c"])).toThrow();
    expect(() => parseArgs(["--subject=SUB"])).toThrow();
    expect(() => parseArgs(["--subject="])).toThrow();
    const ok = parseArgs(["--subject=sub", "--email", "a@b.c"]);
    expect("notes" in ok && ok.notes.length).toBe(1);
  });
});
