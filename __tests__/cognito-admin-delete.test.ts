/**
 * CognitoAuthProvider.adminDeleteUser — erasure's identity step (TASK-193, audit B-8/D-9): the
 * identity is deleted with the administrative credentials (SigV4-signed AdminDeleteUser), named by
 * the pool username its subject resolves to (ListUsers — a federated user's is not its subject:
 * review round 1); none with the subject is not found; without the credentials nothing is sent
 * unsigned. Its remembered verifications are revoked once it is gone.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRevoke = jest.fn(async () => undefined);
jest.mock("@/platform/auth/token-verification", () => ({
  ...jest.requireActual("@/platform/auth/token-verification"),
  revokeTokenVerification: (...a: unknown[]) => mockRevoke(...(a as [])),
}));

import {
  CognitoAuthProvider,
  type CognitoConfig,
} from "@/platform/auth/cognito-provider";
import { TEST_JWKS } from "./helpers/test-jwt";

const SUB = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
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
beforeEach(() => {
  mockFetch = jest.fn();
  global.fetch = mockFetch;
  mockRevoke.mockClear();
});
afterEach(() => {
  global.fetch = originalFetch;
});

const target = (n: number) => {
  const [, init] = mockFetch.mock.calls[n] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return {
    action: Object.entries(headers)
      .find(([k]) => k.toLowerCase() === "x-amz-target")?.[1]
      ?.split(".")
      .pop(),
    body: JSON.parse(String(init.body)),
    signed: Object.keys(headers).some((k) => k.toLowerCase() === "authorization"),
  };
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const refused = (type: string) => ({
  ok: false,
  status: 400,
  json: async () => ({ __type: type, message: type }),
});
const listed = (...users: Array<[string, string]>) =>
  ok({
    Users: users.map(([username, sub]) => ({
      Username: username,
      Attributes: [{ Name: "sub", Value: sub }],
    })),
  });

describe("CognitoAuthProvider.adminDeleteUser (TASK-193)", () => {
  it("finds the pool user by its subject, deletes it with a signed AdminDeleteUser, and revokes its verifications", async () => {
    mockFetch.mockResolvedValueOnce(listed([SUB, SUB])).mockResolvedValueOnce(ok({}));
    await expect(new CognitoAuthProvider(ADMIN).adminDeleteUser(SUB)).resolves.toEqual({
      success: true,
    });
    expect(target(0)).toEqual({
      action: "ListUsers",
      body: { UserPoolId: "us-east-1_TestPool", Filter: `sub = "${SUB}"`, Limit: 2 },
      signed: true,
    });
    expect(target(1)).toEqual({
      action: "AdminDeleteUser",
      body: { UserPoolId: "us-east-1_TestPool", Username: SUB },
      signed: true,
    });
    expect(mockRevoke).toHaveBeenCalledWith(SUB);
  });

  // Review round 1, item 1: a federated user's username is not its subject. Named by the
  // subject, AdminDeleteUser answered UserNotFoundException — counted done, the identity kept.
  it("deletes a federated identity by the username its subject resolves to (Google_…)", async () => {
    mockFetch
      .mockResolvedValueOnce(listed(["Google_118234567890", SUB]))
      .mockResolvedValueOnce(ok({}));
    await expect(new CognitoAuthProvider(ADMIN).adminDeleteUser(SUB)).resolves.toEqual({
      success: true,
    });
    expect(target(1).body).toEqual({
      UserPoolId: "us-east-1_TestPool",
      Username: "Google_118234567890",
    });
  });

  it("no pool user with the subject is not found — nothing deleted", async () => {
    mockFetch.mockResolvedValueOnce(listed());
    await expect(new CognitoAuthProvider(ADMIN).adminDeleteUser(SUB)).resolves.toEqual({
      success: true,
      notFound: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a user gone between the lookup and the delete is not found", async () => {
    mockFetch
      .mockResolvedValueOnce(listed([SUB, SUB]))
      .mockResolvedValueOnce(refused("UserNotFoundException"));
    await expect(new CognitoAuthProvider(ADMIN).adminDeleteUser(SUB)).resolves.toEqual({
      success: true,
      notFound: true,
    });
  });

  it("two pool users with one subject fail (never a guess): the erasure retries and alerts", async () => {
    mockFetch.mockResolvedValueOnce(listed(["a", SUB], ["b", SUB]));
    const r = await new CognitoAuthProvider(ADMIN).adminDeleteUser(SUB);
    expect(r.success).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a subject no pool user can have is not found, and never reaches a filter", async () => {
    await expect(
      new CognitoAuthProvider(ADMIN).adminDeleteUser('x" or sub = "y')
    ).resolves.toEqual({ success: true, notFound: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(["ListUsers", "AdminDeleteUser"])(
    "a refusal of %s (the key lacks it) is a coded failure: the erasure retries it",
    async (at) => {
      if (at === "ListUsers")
        mockFetch.mockResolvedValueOnce(refused("AccessDeniedException"));
      else
        mockFetch
          .mockResolvedValueOnce(listed([SUB, SUB]))
          .mockResolvedValueOnce(refused("AccessDeniedException"));
      const r = await new CognitoAuthProvider(ADMIN).adminDeleteUser(SUB);
      expect(r.success).toBe(false);
      expect(mockRevoke).not.toHaveBeenCalled();
    }
  );

  it("without administrative credentials fails, never calling unsigned", async () => {
    const r = await new CognitoAuthProvider(BASE).adminDeleteUser(SUB);
    expect(r.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("CognitoAuthProvider.confirmIdentityPool (TASK-193 round 1)", () => {
  it("names its pool, and confirms it only when DescribeUserPool answers that pool", async () => {
    const p = new CognitoAuthProvider(ADMIN);
    expect(p.identityPoolId()).toBe("us-east-1_TestPool");
    mockFetch.mockResolvedValueOnce(ok({ UserPool: { Id: "us-east-1_TestPool" } }));
    await expect(p.confirmIdentityPool()).resolves.toBe(true);
    expect(target(0).action).toBe("DescribeUserPool");
    mockFetch.mockResolvedValueOnce(ok({ UserPool: { Id: "us-east-1_Other" } }));
    await expect(p.confirmIdentityPool()).resolves.toBe(false);
    mockFetch.mockResolvedValueOnce(refused("AccessDeniedException"));
    await expect(p.confirmIdentityPool()).resolves.toBe(false);
    await expect(new CognitoAuthProvider(BASE).confirmIdentityPool()).resolves.toBe(
      false
    );
  });
});

describe("CognitoAuthProvider.identityInPool (S2 round 2)", () => {
  it("true only when the pool has exactly one user with the subject", async () => {
    const p = new CognitoAuthProvider(ADMIN);
    mockFetch.mockResolvedValueOnce(listed(["Google_1", SUB]));
    await expect(p.identityInPool(SUB)).resolves.toBe(true);
    expect(target(0).action).toBe("ListUsers");
    mockFetch.mockResolvedValueOnce(listed());
    await expect(p.identityInPool(SUB)).resolves.toBe(false);
    mockFetch.mockResolvedValueOnce(listed(["a", SUB], ["b", SUB]));
    await expect(p.identityInPool(SUB)).resolves.toBeUndefined();
    mockFetch.mockResolvedValueOnce(refused("AccessDeniedException"));
    await expect(p.identityInPool(SUB)).resolves.toBeUndefined();
    await expect(p.identityInPool("not-a-subject")).resolves.toBe(false);
  });
});
