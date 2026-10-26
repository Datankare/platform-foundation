/**
 * CognitoAuthProvider — the tenant attribute (ADR-053 D2): reading it from a verified token,
 * assigning it with signed administrative calls, and checking that the pool keeps it safe.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getCache } from "@/platform/cache";
import {
  CognitoAuthProvider,
  TENANT_ATTRIBUTE,
  type CognitoConfig,
} from "@/platform/auth/cognito-provider";
import { TEST_JWKS, signJwt } from "./helpers/test-jwt";

const TENANT = "11111111-1111-4111-8111-111111111111";
const BASE: CognitoConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  timeoutMs: 5000,
  jwks: TEST_JWKS,
};
const ADMIN: CognitoConfig = {
  ...BASE,
  adminCredentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
};

const originalFetch = global.fetch;
let mockFetch: jest.Mock;
// Each test asks GetUser afresh: what an earlier one verified is not remembered for it
// (platform/auth/token-verification.ts — tested on its own).
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
const fail = (type: string, status = 400) => ({
  ok: false,
  status,
  json: async () => ({ __type: type, message: type }),
});
// Signed as the pool signs (review 8 M5: the provider checks the signature before GetUser).
const fakeJwt = (payload: Record<string, unknown>) => signJwt(payload);

/** The action and body of the n-th call, and its headers. */
function call(n: number) {
  const [, init] = mockFetch.mock.calls[n] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  const target = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === "x-amz-target"
  )?.[1];
  return {
    action: target?.split(".").pop(),
    body: JSON.parse(String(init.body)),
    headers,
  };
}

describe("verifyToken carries the tenant attribute", () => {
  // An access token issued to this app client (audit A-3).
  const token = fakeJwt({
    sub: "user-1",
    token_use: "access",
    client_id: BASE.clientId,
    iss: `https://cognito-idp.${BASE.region}.amazonaws.com/${BASE.userPoolId}`,
    iat: 1000,
    exp: 9_999_999_999,
  });

  it("reports the tenant the pool holds", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        Username: "user-1",
        UserAttributes: [
          { Name: "sub", Value: "user-1" },
          { Name: TENANT_ATTRIBUTE, Value: TENANT },
        ],
      })
    );
    expect((await new CognitoAuthProvider(BASE).verifyToken(token))?.tenantId).toBe(
      TENANT
    );
  });

  it("reports none when the attribute is absent or empty", async () => {
    mockFetch
      .mockResolvedValueOnce(
        ok({ Username: "user-1", UserAttributes: [{ Name: "sub", Value: "user-1" }] })
      )
      .mockResolvedValueOnce(
        ok({
          Username: "user-1",
          UserAttributes: [
            { Name: "sub", Value: "user-1" },
            { Name: TENANT_ATTRIBUTE, Value: "" },
          ],
        })
      );
    const p = new CognitoAuthProvider(BASE);
    expect((await p.verifyToken(token))?.tenantId).toBeUndefined();
    expect((await p.verifyToken(token))?.tenantId).toBeUndefined();
  });

  it("passes a malformed value on, for the resolver to refuse — never read as 'no tenant'", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        Username: "user-1",
        UserAttributes: [
          { Name: "sub", Value: "user-1" },
          { Name: TENANT_ATTRIBUTE, Value: "not-a-uuid" },
        ],
      })
    );
    expect((await new CognitoAuthProvider(BASE).verifyToken(token))?.tenantId).toBe(
      "not-a-uuid"
    );
  });
});

describe("an attribute change voids remembered verifications (review 8 M1)", () => {
  const token = fakeJwt({
    sub: "user-1",
    username: "user-1",
    token_use: "access",
    client_id: BASE.clientId,
    iss: `https://cognito-idp.${BASE.region}.amazonaws.com/${BASE.userPoolId}`,
    iat: 1000,
    exp: 9_999_999_999,
  });
  const getUser = (verified: boolean) =>
    ok({
      Username: "user-1",
      UserAttributes: [
        { Name: "sub", Value: "user-1" },
        { Name: "email_verified", Value: String(verified) },
      ],
    });

  it("after the address is verified, the next request reads it from the pool, not the cache", async () => {
    const p = new CognitoAuthProvider(ADMIN);
    mockFetch.mockResolvedValueOnce(getUser(false));
    expect((await p.verifyToken(token))?.emailVerified).toBe(false);
    mockFetch
      .mockResolvedValueOnce(ok({})) // ConfirmSignUp
      // AdminGetUser: the token's subject is the user's sub (TASK-177), never its username.
      .mockResolvedValueOnce(
        ok({ Username: "Google_1", UserAttributes: [{ Name: "sub", Value: "user-1" }] })
      )
      .mockResolvedValueOnce(getUser(true));
    expect(await p.confirmEmailVerification("a@b.c", "123456")).toEqual({
      success: true,
    });
    expect(call(2).action).toBe("AdminGetUser");
    expect((await p.verifyToken(token))?.emailVerified).toBe(true);
    expect(call(3).action).toBe("GetUser");
  });

  it("a lookup that fails is logged; the verification still succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(fail("InternalErrorException", 500));
    expect(
      await new CognitoAuthProvider(ADMIN).confirmEmailVerification("a@b.c", "1")
    ).toEqual({ success: true });
  });

  it("without administrative credentials nothing more is called", async () => {
    mockFetch.mockResolvedValueOnce(ok({}));
    await new CognitoAuthProvider(BASE).confirmEmailVerification("a@b.c", "1");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("assignTenant", () => {
  it("refuses a malformed tenant id without calling Cognito", async () => {
    const r = await new CognitoAuthProvider(ADMIN).assignTenant("user-1", "nope");
    expect(r).toMatchObject({ success: false, errorCode: "request.invalid_body" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("without administrative credentials fails, never calling unsigned", async () => {
    const r = await new CognitoAuthProvider(BASE).assignTenant("user-1", TENANT);
    expect(r.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sets the attribute with a SigV4-signed AdminUpdateUserAttributes", async () => {
    mockFetch.mockResolvedValueOnce(ok({}));
    const r = await new CognitoAuthProvider(ADMIN).assignTenant("user-1", TENANT);
    expect(r).toEqual({ success: true });
    const c = call(0);
    expect(c.action).toBe("AdminUpdateUserAttributes");
    expect(c.body).toEqual({
      UserPoolId: "us-east-1_TestPool",
      Username: "user-1",
      UserAttributes: [{ Name: TENANT_ATTRIBUTE, Value: TENANT }],
    });
    const auth = Object.entries(c.headers).find(
      ([k]) => k.toLowerCase() === "authorization"
    );
    expect(auth?.[1]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/cognito-idp\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/
    );
    expect(JSON.stringify(c.headers)).not.toContain(
      ADMIN.adminCredentials!.secretAccessKey
    );
  });

  it("TASK-177: a federated user's subject (its sub) is addressed by the pool username its signed token named — Cognito accepts no federated sub there", async () => {
    const SUB = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const p = new CognitoAuthProvider(ADMIN);
    // Not seen yet: addressed by the sub (right for every native user).
    mockFetch.mockResolvedValueOnce(ok({}));
    await p.assignTenant(SUB, TENANT);
    expect(call(0).body.Username).toBe(SUB);
    // A signed token of the user names its username: used from then on.
    mockFetch.mockResolvedValueOnce(
      ok({ Username: "Google_1093", UserAttributes: [{ Name: "sub", Value: SUB }] })
    );
    await p.verifyToken(
      fakeJwt({
        sub: SUB,
        username: "Google_1093",
        token_use: "access",
        client_id: BASE.clientId,
        iss: `https://cognito-idp.${BASE.region}.amazonaws.com/${BASE.userPoolId}`,
        iat: 1000,
        exp: 9_999_999_999,
      })
    );
    mockFetch.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok({}));
    await expect(p.assignTenant(SUB, TENANT)).resolves.toEqual({ success: true });
    expect(call(2)).toMatchObject({
      action: "AdminUpdateUserAttributes",
      body: { Username: "Google_1093" },
    });
    await p.getUserTenant(SUB);
    expect(call(3)).toMatchObject({
      action: "AdminGetUser",
      body: { Username: "Google_1093" },
    });
  });

  it("maps a Cognito refusal to a coded failure", async () => {
    mockFetch.mockResolvedValueOnce(fail("UserNotFoundException"));
    const r = await new CognitoAuthProvider(ADMIN).assignTenant("ghost", TENANT);
    expect(r.success).toBe(false);
    expect(r.errorCode).toEqual(expect.any(String));
  });
});

describe("getUserTenant", () => {
  it("reads the attribute, or null when the user has none", async () => {
    mockFetch
      .mockResolvedValueOnce(
        ok({ UserAttributes: [{ Name: TENANT_ATTRIBUTE, Value: TENANT }] })
      )
      .mockResolvedValueOnce(ok({ UserAttributes: [{ Name: "email", Value: "a@b.c" }] }))
      .mockResolvedValueOnce(ok({}));
    const p = new CognitoAuthProvider(ADMIN);
    expect(await p.getUserTenant("u")).toBe(TENANT);
    expect(await p.getUserTenant("u")).toBeNull();
    expect(await p.getUserTenant("u")).toBeNull();
    expect(call(0).action).toBe("AdminGetUser");
  });

  it("undefined — not null — when it cannot be read (unknown is not 'none')", async () => {
    mockFetch.mockResolvedValueOnce(fail("InternalErrorException", 500));
    expect(await new CognitoAuthProvider(ADMIN).getUserTenant("u")).toBeUndefined();
    expect(await new CognitoAuthProvider(BASE).getUserTenant("u")).toBeUndefined();
  });
});

describe("checkTenantAttribute — the pool keeps tenants safe", () => {
  const pool = (attr?: Record<string, unknown>) =>
    ok({
      UserPool: {
        SchemaAttributes: [
          { Name: "email" },
          ...(attr ? [{ Name: TENANT_ATTRIBUTE, ...attr }] : []),
        ],
      },
    });
  const STRING = { AttributeDataType: "String", Mutable: true };
  const list = (ids: string[], next?: string) =>
    ok({
      UserPoolClients: ids.map((ClientId) => ({ ClientId })),
      ...(next ? { NextToken: next } : {}),
    });
  const client = (c: Record<string, unknown>) => ok({ UserPoolClient: c });
  const SAFE = {
    ReadAttributes: ["email", TENANT_ATTRIBUTE],
    WriteAttributes: ["email"],
  };
  const check = () => new CognitoAuthProvider(ADMIN).checkTenantAttribute();

  it("unknown without administrative credentials", async () => {
    expect(await new CognitoAuthProvider(BASE).checkTenantAttribute()).toMatchObject({
      state: "unknown",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("missing when the pool has no such attribute", async () => {
    mockFetch.mockResolvedValueOnce(pool());
    expect(await check()).toMatchObject({ state: "missing" });
  });

  it("unsafe when it is not a String, or immutable", async () => {
    mockFetch.mockResolvedValueOnce(pool({ AttributeDataType: "Number", Mutable: true }));
    expect(await check()).toMatchObject({ state: "unsafe", reason: /String/ });
    mockFetch.mockResolvedValueOnce(
      pool({ AttributeDataType: "String", Mutable: false })
    );
    expect(await check()).toMatchObject({ state: "unsafe", reason: /immutable/ });
  });

  it("unsafe when the app client may write it — listed, or no write list at all", async () => {
    mockFetch
      .mockResolvedValueOnce(pool(STRING))
      .mockResolvedValueOnce(list(["test-client-id"]))
      .mockResolvedValueOnce(
        client({ ...SAFE, WriteAttributes: ["email", TENANT_ATTRIBUTE] })
      );
    expect(await check()).toMatchObject({
      state: "unsafe",
      reason: /the app client can write/,
    });
    mockFetch
      .mockResolvedValueOnce(pool(STRING))
      .mockResolvedValueOnce(list(["test-client-id"]))
      .mockResolvedValueOnce(client({ ReadAttributes: SAFE.ReadAttributes }));
    expect(await check()).toMatchObject({ state: "unsafe", reason: /can write/ });
  });

  it("unsafe when ANOTHER app client of the pool may write it — on any page of the list", async () => {
    mockFetch
      .mockResolvedValueOnce(pool(STRING))
      .mockResolvedValueOnce(list(["test-client-id"], "page-2"))
      .mockResolvedValueOnce(list(["admin-tool-client"]))
      .mockResolvedValueOnce(client(SAFE))
      .mockResolvedValueOnce(client({ WriteAttributes: [TENANT_ATTRIBUTE] }));
    expect(await check()).toMatchObject({
      state: "unsafe",
      reason: /app client admin-tool-client can write/,
    });
    expect(call(2)).toMatchObject({
      action: "ListUserPoolClients",
      body: { NextToken: "page-2" },
    });
  });

  it("unsafe when the app client cannot read it", async () => {
    mockFetch
      .mockResolvedValueOnce(pool(STRING))
      .mockResolvedValueOnce(list(["test-client-id"]))
      .mockResolvedValueOnce(client({ ...SAFE, ReadAttributes: ["email"] }));
    expect(await check()).toMatchObject({ state: "unsafe", reason: /cannot read/ });
  });

  it("unsafe when a federated sign-in of any client maps a claim into it", async () => {
    mockFetch
      .mockResolvedValueOnce(pool(STRING))
      .mockResolvedValueOnce(list(["test-client-id", "other"]))
      .mockResolvedValueOnce(client({ ...SAFE, SupportedIdentityProviders: ["COGNITO"] }))
      .mockResolvedValueOnce(client({ ...SAFE, SupportedIdentityProviders: ["Google"] }))
      .mockResolvedValueOnce(
        ok({
          IdentityProvider: {
            AttributeMapping: { email: "email", [TENANT_ATTRIBUTE]: "hd" },
          },
        })
      );
    expect(await check()).toMatchObject({ state: "unsafe", reason: /Google/ });
    expect(call(4)).toMatchObject({
      action: "DescribeIdentityProvider",
      body: { ProviderName: "Google" },
    });
  });

  it("ready when every condition holds for every client, signing each call", async () => {
    mockFetch
      .mockResolvedValueOnce(pool({ Mutable: true }))
      .mockResolvedValueOnce(list(["other"])) // this app's client is checked even if unlisted
      .mockResolvedValueOnce(client({ ...SAFE, SupportedIdentityProviders: ["Google"] }))
      .mockResolvedValueOnce(client({ ...SAFE, SupportedIdentityProviders: ["Google"] }))
      .mockResolvedValueOnce(
        ok({ IdentityProvider: { AttributeMapping: { email: "email" } } })
      );
    expect(await check()).toEqual({ state: "ready" });
    expect([0, 1, 2, 3, 4].map((n) => call(n).action)).toEqual([
      "DescribeUserPool",
      "ListUserPoolClients",
      "DescribeUserPoolClient",
      "DescribeUserPoolClient",
      "DescribeIdentityProvider", // once per provider, not per client
    ]);
    expect(call(3).body).toMatchObject({ ClientId: "test-client-id" });
    for (const n of [0, 1, 2, 3, 4]) {
      expect(JSON.stringify(call(n).headers)).toMatch(/AWS4-HMAC-SHA256/);
    }
  });

  it("unknown when the pool cannot be described — never ready by default", async () => {
    mockFetch.mockResolvedValueOnce(fail("AccessDeniedException", 403));
    expect(await check()).toMatchObject({ state: "unknown", reason: /AccessDenied/ });
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await check()).toMatchObject({ state: "unknown" });
    mockFetch
      .mockResolvedValueOnce(pool(STRING))
      .mockResolvedValueOnce(fail("AccessDeniedException", 403)); // no ListUserPoolClients
    expect(await check()).toMatchObject({ state: "unknown" });
  });
});
