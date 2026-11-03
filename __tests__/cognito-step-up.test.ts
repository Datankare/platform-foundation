/**
 * __tests__/cognito-step-up.test.ts — CognitoAuthProvider.confirmCurrentFactor (TASK-194, audit
 * C-3)
 *
 * The step-up proves the token's own user holds the enrolled factor now: GetUser names the pool
 * username, a password sign-in must be answered with a SOFTWARE_TOKEN_MFA challenge, and the code
 * must pass it. The session that sign-in makes is revoked. Hostile cases: no factor enrolled, a
 * sign-in that asks for no factor, a wrong password or code, another user's proof, and a
 * federated (SSO) account, which is told the proof is unavailable and how to recover — never
 * let through.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  CognitoAuthProvider,
  type CognitoConfig,
} from "@/platform/auth/cognito-provider";

const CONFIG: CognitoConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  timeoutMs: 5000,
};
const SUB = "11111111-2222-4333-8444-555555555555";

const ok = (body: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const err = (type: string) => ({
  ok: false,
  status: 400,
  json: async () => ({ __type: type, message: type }),
});
const jwt = (sub: string) =>
  `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;
const user = (mfa: string[]) =>
  ok({
    Username: "pool-user",
    UserAttributes: [{ Name: "sub", Value: SUB }],
    UserMFASettingList: mfa,
  });

const IDENTITIES = JSON.stringify([{ providerName: "Google", providerType: "Google" }]);
const federatedUser = (mfa: string[]) =>
  ok({
    Username: "Google_1234567890",
    UserAttributes: [
      { Name: "sub", Value: SUB },
      { Name: "identities", Value: IDENTITIES },
    ],
    UserMFASettingList: mfa,
  });

const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
});

/** The Cognito operation (X-Amz-Target) and body of each call made. */
const calls = () =>
  fetchMock.mock.calls.map(([, init]) => ({
    op: String(
      (init as RequestInit).headers &&
        (init.headers as Record<string, string>)["X-Amz-Target"]
    ).replace(/^.*\./, ""),
    body: JSON.parse(String((init as RequestInit).body)),
  }));

const provider = () => new CognitoAuthProvider(CONFIG);

describe("confirmCurrentFactor", () => {
  it("proves the factor with the token user's own sign-in, then revokes that session", async () => {
    fetchMock
      .mockResolvedValueOnce(user(["SOFTWARE_TOKEN_MFA"]))
      .mockResolvedValueOnce(ok({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "sess" }))
      .mockResolvedValueOnce(
        ok({ AuthenticationResult: { AccessToken: jwt(SUB), RefreshToken: "r1" } })
      )
      .mockResolvedValueOnce(ok({}));
    expect(await provider().confirmCurrentFactor("tok", "pw", "123456")).toEqual({
      success: true,
    });
    const c = calls();
    expect(c.map((x) => x.op)).toEqual([
      "GetUser",
      "InitiateAuth",
      "RespondToAuthChallenge",
      "RevokeToken",
    ]);
    expect(c[1].body.AuthParameters).toMatchObject({
      USERNAME: "pool-user",
      PASSWORD: "pw",
    });
    expect(c[2].body.ChallengeResponses).toMatchObject({
      USERNAME: "pool-user",
      SOFTWARE_TOKEN_MFA_CODE: "123456",
    });
    expect(c[3].body.Token).toBe("r1");
  });

  it("refuses an account with no factor enrolled, without signing in", async () => {
    fetchMock.mockResolvedValueOnce(user([]));
    expect(await provider().confirmCurrentFactor("tok", "pw", "123456")).toMatchObject({
      success: false,
      errorCode: "auth.step_up_required",
    });
    expect(calls().map((x) => x.op)).toEqual(["GetUser"]);
  });

  it("refuses a sign-in that asked for no factor, and revokes it", async () => {
    fetchMock
      .mockResolvedValueOnce(user(["SOFTWARE_TOKEN_MFA"]))
      .mockResolvedValueOnce(
        ok({ AuthenticationResult: { AccessToken: jwt(SUB), RefreshToken: "r2" } })
      )
      .mockResolvedValueOnce(ok({}));
    expect(await provider().confirmCurrentFactor("tok", "pw", "123456")).toMatchObject({
      success: false,
      errorCode: "auth.step_up_required",
    });
    expect(calls().at(-1)).toMatchObject({ op: "RevokeToken", body: { Token: "r2" } });
  });

  it("passes a wrong password or code on, coded", async () => {
    fetchMock
      .mockResolvedValueOnce(user(["SOFTWARE_TOKEN_MFA"]))
      .mockResolvedValueOnce(err("NotAuthorizedException"));
    expect(await provider().confirmCurrentFactor("tok", "bad", "123456")).toMatchObject({
      success: false,
      errorCode: "auth.invalid_credentials",
    });
    fetchMock
      .mockResolvedValueOnce(user(["SOFTWARE_TOKEN_MFA"]))
      .mockResolvedValueOnce(ok({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s" }))
      .mockResolvedValueOnce(err("CodeMismatchException"));
    expect(await provider().confirmCurrentFactor("tok", "pw", "000000")).toMatchObject({
      success: false,
      errorCode: "auth.code_invalid",
    });
  });

  it("refuses a proof that signed in another user", async () => {
    fetchMock
      .mockResolvedValueOnce(user(["SOFTWARE_TOKEN_MFA"]))
      .mockResolvedValueOnce(ok({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s" }))
      .mockResolvedValueOnce(
        ok({
          AuthenticationResult: {
            AccessToken: jwt("99999999-2222-4333-8444-555555555555"),
            RefreshToken: "r3",
          },
        })
      )
      .mockResolvedValueOnce(ok({}));
    expect(await provider().confirmCurrentFactor("tok", "pw", "123456")).toMatchObject({
      success: false,
      errorCode: "auth.token_invalid",
    });
  });
});

describe("confirmCurrentFactor — a federated (SSO) account", () => {
  it("is told the step-up is unavailable when the pool password sign-in is refused", async () => {
    fetchMock
      .mockResolvedValueOnce(federatedUser(["SOFTWARE_TOKEN_MFA"]))
      .mockResolvedValueOnce(err("NotAuthorizedException"));
    expect(await provider().confirmCurrentFactor("tok", "guess", "123456")).toMatchObject(
      {
        success: false,
        errorCode: "auth.step_up_unavailable",
      }
    );
    expect(calls().map((x) => x.op)).toEqual(["GetUser", "InitiateAuth"]);
  });

  it("is told so when it has no factor enrolled, without signing in", async () => {
    fetchMock.mockResolvedValueOnce(federatedUser([]));
    expect(await provider().confirmCurrentFactor("tok", "pw", "123456")).toMatchObject({
      success: false,
      errorCode: "auth.step_up_unavailable",
    });
    expect(calls().map((x) => x.op)).toEqual(["GetUser"]);
  });

  it("still needs the challenge: a linked account with a pool password proves it as anyone", async () => {
    fetchMock
      .mockResolvedValueOnce(federatedUser(["SOFTWARE_TOKEN_MFA"]))
      .mockResolvedValueOnce(ok({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s" }))
      .mockResolvedValueOnce(err("CodeMismatchException"));
    expect(await provider().confirmCurrentFactor("tok", "pw", "000000")).toMatchObject({
      success: false,
      errorCode: "auth.code_invalid",
    });
  });

  it("passes other failures on unchanged", async () => {
    fetchMock
      .mockResolvedValueOnce(federatedUser(["SOFTWARE_TOKEN_MFA"]))
      .mockResolvedValueOnce(err("TooManyRequestsException"));
    expect(await provider().confirmCurrentFactor("tok", "pw", "123456")).toMatchObject({
      success: false,
      errorCode: "auth.too_many_attempts",
    });
  });
});

// TASK-194 round 1, B1: the delegation consent proves the user with the password alone when the
// account has no second factor — never when it has one.
describe("confirmCurrentFactor — a password alone (code null)", () => {
  it("proves an account with no factor by a completed sign-in, then revokes it", async () => {
    fetchMock
      .mockResolvedValueOnce(user([]))
      .mockResolvedValueOnce(
        ok({ AuthenticationResult: { AccessToken: jwt(SUB), RefreshToken: "r9" } })
      )
      .mockResolvedValueOnce(ok({}));
    expect(await provider().confirmCurrentFactor("tok", "pw", null)).toEqual({
      success: true,
    });
    expect(calls().map((x) => x.op)).toEqual(["GetUser", "InitiateAuth", "RevokeToken"]);
  });

  it("refuses an account with a factor: its code is needed — without signing in", async () => {
    fetchMock.mockResolvedValueOnce(user(["SOFTWARE_TOKEN_MFA"]));
    expect(await provider().confirmCurrentFactor("tok", "pw", null)).toMatchObject({
      success: false,
      errorCode: "auth.step_up_required",
    });
    expect(calls().map((x) => x.op)).toEqual(["GetUser"]);
  });

  it("refuses a sign-in that asked for more (a challenge), a wrong password, another user's", async () => {
    fetchMock
      .mockResolvedValueOnce(user([]))
      .mockResolvedValueOnce(
        ok({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s" })
      );
    expect(await provider().confirmCurrentFactor("tok", "pw", null)).toMatchObject({
      errorCode: "auth.step_up_required",
    });
    fetchMock
      .mockResolvedValueOnce(user([]))
      .mockResolvedValueOnce(err("NotAuthorizedException"));
    expect(await provider().confirmCurrentFactor("tok", "bad", null)).toMatchObject({
      errorCode: "auth.invalid_credentials",
    });
    fetchMock
      .mockResolvedValueOnce(user([]))
      .mockResolvedValueOnce(
        ok({
          AuthenticationResult: { AccessToken: jwt("someone-else"), RefreshToken: "r" },
        })
      )
      .mockResolvedValueOnce(ok({}));
    expect(await provider().confirmCurrentFactor("tok", "pw", null)).toMatchObject({
      errorCode: "auth.token_invalid",
    });
  });

  it("tells a federated account without a pool password it cannot", async () => {
    fetchMock
      .mockResolvedValueOnce(federatedUser([]))
      .mockResolvedValueOnce(err("NotAuthorizedException"));
    expect(await provider().confirmCurrentFactor("tok", "guess", null)).toMatchObject({
      errorCode: "auth.step_up_unavailable",
    });
  });
});
