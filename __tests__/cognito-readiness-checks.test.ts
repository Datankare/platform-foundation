/**
 * CognitoAuthProvider.checkErasureAccess and checkClientSecret — what operator readiness asks the
 * pool (N-22, N-52, TASK-203)
 *
 * Erasure: the administrative key is set; DescribeUserPool answers this pool; ListUsers is allowed
 * (a lookup of ERASURE_PROBE_USERNAME, which no pool user can have); AdminDeleteUser is allowed —
 * its delete of that absent name answers UserNotFoundException, never deletes anyone, and is not
 * sent when the lookup found someone. Every call signed; a refusal names the action.
 * Client secret (the owner's decision recorded in TASK-203: on demand, never a sign-in): the
 * app client's secret read with DescribeUserPoolClient and compared with COGNITO_CLIENT_SECRET in
 * constant time; neither ever appears in the answer.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  CognitoAuthProvider,
  type CognitoConfig,
} from "@/platform/auth/cognito-provider";
import {
  ERASURE_PROBE_USERNAME,
  compareClientSecrets,
} from "@/platform/auth/admin-key-readiness";
import { TEST_JWKS } from "./helpers/test-jwt";

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
});
afterEach(() => {
  global.fetch = originalFetch;
});

const call = (n: number) => {
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
  json: async () => ({ __type: type, message: `${type}: not allowed` }),
});
const POOL = ok({ UserPool: { Id: "us-east-1_TestPool" } });

describe("checkErasureAccess (N-22)", () => {
  it("without the administrative key: missing, and nothing is sent", async () => {
    const r = await new CognitoAuthProvider(BASE).checkErasureAccess();
    expect(r).toMatchObject({ state: "missing" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ready when the pool is this one, the lookup is allowed and the delete of an absent name is not found", async () => {
    mockFetch
      .mockResolvedValueOnce(POOL)
      .mockResolvedValueOnce(ok({ Users: [] }))
      .mockResolvedValueOnce(refused("UserNotFoundException"));
    expect(await new CognitoAuthProvider(ADMIN).checkErasureAccess()).toEqual({
      state: "ready",
    });
    expect([0, 1, 2].map((n) => [call(n).action, call(n).signed])).toEqual([
      ["DescribeUserPool", true],
      ["ListUsers", true],
      ["AdminDeleteUser", true],
    ]);
    expect(call(1).body.Filter).toBe(`username = "${ERASURE_PROBE_USERNAME}"`);
    expect(call(2).body).toEqual({
      UserPoolId: "us-east-1_TestPool",
      Username: ERASURE_PROBE_USERNAME,
    });
  });

  it.each([
    ["DescribeUserPool", 0],
    ["ListUsers", 1],
    ["AdminDeleteUser", 2],
  ])("a policy without %s: denied, naming it", async (action, at) => {
    const answers = [POOL, ok({ Users: [] }), refused("UserNotFoundException")];
    answers[at] = refused("AccessDeniedException");
    for (const a of answers) mockFetch.mockResolvedValueOnce(a);
    const r = await new CognitoAuthProvider(ADMIN).checkErasureAccess();
    expect(r).toMatchObject({ state: "denied", action });
    expect((r as { reason: string }).reason).toContain(`cognito-idp:${action}`);
    expect((r as { reason: string }).reason).toContain("cognito-tenancy-and-erasure");
  });

  it("[hostile] a pool user named like the probe: the delete is never sent", async () => {
    mockFetch
      .mockResolvedValueOnce(POOL)
      .mockResolvedValueOnce(ok({ Users: [{ Username: ERASURE_PROBE_USERNAME }] }));
    expect(await new CognitoAuthProvider(ADMIN).checkErasureAccess()).toMatchObject({
      state: "unknown",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("[hostile] another pool answering DescribeUserPool, a delete that succeeds, a throttled pool: never ready", async () => {
    mockFetch.mockResolvedValueOnce(ok({ UserPool: { Id: "us-east-1_Other" } }));
    expect((await new CognitoAuthProvider(ADMIN).checkErasureAccess()).state).toBe(
      "unknown"
    );
    mockFetch
      .mockResolvedValueOnce(POOL)
      .mockResolvedValueOnce(ok({ Users: [] }))
      .mockResolvedValueOnce(ok({}));
    expect((await new CognitoAuthProvider(ADMIN).checkErasureAccess()).state).toBe(
      "unknown"
    );
    mockFetch.mockResolvedValueOnce(refused("TooManyRequestsException"));
    expect((await new CognitoAuthProvider(ADMIN).checkErasureAccess()).state).toBe(
      "unknown"
    );
  });

  it("the probe name can be no pool user's: not a UUID, not an address, no provider prefix", () => {
    expect(ERASURE_PROBE_USERNAME).not.toMatch(/@|_|^[0-9a-f-]{36}$/i);
  });
});

describe("checkClientSecret (N-52)", () => {
  const SECRET = "s3cr3t-of-the-app-client-0123456789abcdefghij";

  it("without the administrative key: not checkable, nothing sent", async () => {
    const r = await new CognitoAuthProvider({
      ...BASE,
      clientSecret: SECRET,
    }).checkClientSecret();
    expect(r.state).toBe("not_checkable");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ready when the held secret is the client's; a mismatch otherwise — never the secret in the answer", async () => {
    mockFetch.mockResolvedValueOnce(ok({ UserPoolClient: { ClientSecret: SECRET } }));
    const p = new CognitoAuthProvider({ ...ADMIN, clientSecret: SECRET });
    expect(await p.checkClientSecret()).toEqual({ state: "ready" });
    expect(call(0)).toMatchObject({
      action: "DescribeUserPoolClient",
      signed: true,
      body: { UserPoolId: "us-east-1_TestPool", ClientId: "test-client-id" },
    });
    mockFetch.mockResolvedValueOnce(ok({ UserPoolClient: { ClientSecret: "rotated" } }));
    const r = await p.checkClientSecret();
    expect(r.state).toBe("mismatch");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain("rotated");
  });

  it("a client with a secret and none held, or one held for a client without: mismatch", () => {
    expect(compareClientSecrets("x", undefined).state).toBe("mismatch");
    expect(compareClientSecrets(undefined, "x").state).toBe("mismatch");
    expect(compareClientSecrets(undefined, undefined).state).toBe("ready");
    expect(compareClientSecrets("ab", "abc").state).toBe("mismatch");
  });

  it("a refused or unanswered read is unknown", async () => {
    mockFetch.mockResolvedValueOnce(refused("AccessDeniedException"));
    expect(
      (
        await new CognitoAuthProvider({
          ...ADMIN,
          clientSecret: SECRET,
        }).checkClientSecret()
      ).state
    ).toBe("unknown");
  });
});
