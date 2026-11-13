/**
 * __tests__/cognito-sessions.test.ts — what server-side sessions ask of the Cognito provider
 * (ADR-057 D3, D6, D7; TASK-214)
 *
 * The session's user is read with the administrative key (AdminGetUser), so the user's own token
 * — which may carry the aws.cognito.signin.user.admin scope (SEC-018) — is not presented to
 * Cognito to verify a request. Sign-out everywhere and removing a factor are administrative
 * calls by the user's id. Renewal tells a refusal (the session ends) from no answer (it is kept).
 * Hosted sign-in stops asking for the scope once the key exists.
 *
 * Hostile cases: a user disabled in the pool mid-session; AdminGetUser answering another
 * subject's record; a key whose policy lacks an action (the deployment degrades, nothing fails
 * open); a refresh token that renews as someone else; a revoked refresh token; Cognito down.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { getCache } from "@/platform/cache";
import {
  CognitoAuthProvider,
  ssoScopes,
  type CognitoConfig,
} from "@/platform/auth/cognito-provider";
import { ERASURE_PROBE_USERNAME } from "@/platform/auth/admin-key-readiness";
import { TEST_JWKS, signJwt } from "./helpers/test-jwt";

const SUB = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const KEYLESS: CognitoConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  timeoutMs: 5000,
  jwks: TEST_JWKS,
  hostedUiDomain: "auth.example.com",
};
const CONFIG: CognitoConfig = {
  ...KEYLESS,
  adminCredentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
};

const ok = (body: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const err = (type: string, status = 400) => ({
  ok: false,
  status,
  json: async () => ({ __type: type, message: type }),
});

const accessToken = (sub = SUB, extra: Record<string, unknown> = {}) =>
  signJwt({
    sub,
    username: sub,
    token_use: "access",
    client_id: CONFIG.clientId,
    iss: `https://cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}`,
    iat: 1000,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  });
const poolUser = (sub = SUB, extra: Record<string, unknown> = {}) =>
  ok({
    Username: sub,
    Enabled: true,
    UserAttributes: [
      { Name: "sub", Value: sub },
      { Name: "email", Value: "a@example.com" },
      { Name: "email_verified", Value: "true" },
    ],
    UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
    ...extra,
  });

const originalFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  getCache().clear();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
});

/** The Cognito operation, body and whether the call was IAM-signed, for each call made. */
const calls = () =>
  fetchMock.mock.calls.map(([, init]) => {
    const headers = init.headers as Record<string, string>;
    return {
      op: String(headers["X-Amz-Target"] ?? headers["x-amz-target"]).replace(/^.*\./, ""),
      signed: Boolean(headers.authorization ?? headers.Authorization),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    };
  });
const sent = () => JSON.stringify(fetchMock.mock.calls.map(([, init]) => init.body));

describe("verifyToken reads the user with the administrative key (ADR-057 D7)", () => {
  it("AdminGetUser, signed, by the token's username — the token itself is not sent to Cognito", async () => {
    const token = accessToken();
    fetchMock.mockResolvedValueOnce(poolUser());
    const payload = await new CognitoAuthProvider(CONFIG).verifyToken(token);
    expect(payload).toMatchObject({ sub: SUB, email: "a@example.com", mfaEnabled: true });
    expect(calls()).toEqual([
      {
        op: "AdminGetUser",
        signed: true,
        body: { UserPoolId: CONFIG.userPoolId, Username: SUB },
      },
    ]);
    expect(sent()).not.toContain(token);
  });

  it("a federated user is read by the pool username its signed token names, not its subject", async () => {
    const token = accessToken(SUB, { username: "Google_1093" });
    fetchMock.mockResolvedValueOnce(poolUser(SUB, { Username: "Google_1093" }));
    await new CognitoAuthProvider(CONFIG).verifyToken(token);
    expect(calls()[0].body.Username).toBe("Google_1093");
  });

  it("a user disabled in the pool mid-session is refused at once", async () => {
    fetchMock.mockResolvedValueOnce(poolUser(SUB, { Enabled: false }));
    expect(await new CognitoAuthProvider(CONFIG).verifyToken(accessToken())).toBeNull();
  });

  it("a user deleted from the pool is refused", async () => {
    fetchMock.mockResolvedValueOnce(err("UserNotFoundException"));
    expect(await new CognitoAuthProvider(CONFIG).verifyToken(accessToken())).toBeNull();
  });

  it("an answer about another subject, or naming none, is not believed", async () => {
    for (const answer of [
      poolUser(OTHER),
      ok({ Username: SUB, Enabled: true, UserAttributes: [] }),
    ]) {
      getCache().clear();
      fetchMock.mockResolvedValueOnce(answer);
      expect(await new CognitoAuthProvider(CONFIG).verifyToken(accessToken())).toBeNull();
    }
  });

  it("Cognito not answering is 'unavailable', never 'valid' and never a sign-out", async () => {
    fetchMock.mockResolvedValueOnce(err("TooManyRequestsException"));
    await expect(
      new CognitoAuthProvider(CONFIG).verifyToken(accessToken())
    ).rejects.toThrow();
  });

  it("a key whose policy lacks AdminGetUser: sign-in still works — the token's own GetUser verifies, as before", async () => {
    const token = accessToken();
    fetchMock
      .mockResolvedValueOnce(err("AccessDeniedException"))
      .mockResolvedValueOnce(poolUser());
    const payload = await new CognitoAuthProvider(CONFIG).verifyToken(token);
    expect(payload).toMatchObject({ sub: SUB });
    expect(calls().map((c) => [c.op, c.signed])).toEqual([
      ["AdminGetUser", true],
      ["GetUser", false],
    ]);
    expect(calls()[1].body).toEqual({ AccessToken: token });
  });

  it("no administrative key: GetUser with the token, as before ADR-057", async () => {
    fetchMock.mockResolvedValueOnce(poolUser());
    await new CognitoAuthProvider(KEYLESS).verifyToken(accessToken());
    expect(calls().map((c) => c.op)).toEqual(["GetUser"]);
  });
});

describe("hosted sign-in's scopes (ADR-057 D7)", () => {
  it("with the administrative key the admin scope is not asked for; without it, it still is", () => {
    expect(ssoScopes(true).split(" ")).toEqual(["openid", "email", "profile"]);
    expect(ssoScopes(false).split(" ")).toContain("aws.cognito.signin.user.admin");
  });

  it("the redirect a browser is sent to carries exactly those scopes", async () => {
    const scopeOf = async (config: CognitoConfig) => {
      const r = await new CognitoAuthProvider(config).initiateSso(
        "google",
        "https://app.example.com/auth/callback",
        { state: "s".repeat(43), codeChallenge: "c".repeat(43) }
      );
      return new URL(r.redirectUrl!).searchParams.get("scope");
    };
    expect(await scopeOf(CONFIG)).toBe("openid email profile");
    expect(await scopeOf(KEYLESS)).toBe(
      "openid email profile aws.cognito.signin.user.admin"
    );
  });
});

describe("signOutEverywhere (ADR-057 D6)", () => {
  it("AdminUserGlobalSignOut, signed, by the user's id", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    expect(await new CognitoAuthProvider(CONFIG).signOutEverywhere(SUB)).toEqual({
      success: true,
    });
    expect(calls()).toEqual([
      {
        op: "AdminUserGlobalSignOut",
        signed: true,
        body: { UserPoolId: CONFIG.userPoolId, Username: SUB },
      },
    ]);
  });

  it("a user the pool no longer has is signed out already", async () => {
    fetchMock.mockResolvedValueOnce(err("UserNotFoundException"));
    expect((await new CognitoAuthProvider(CONFIG).signOutEverywhere(SUB)).success).toBe(
      true
    );
  });

  it.each([
    ["the key's policy lacks the action", CONFIG, err("AccessDeniedException")],
    ["Cognito is down", CONFIG, err("InternalErrorException", 500)],
    ["there is no administrative key", KEYLESS, null],
  ])(
    "%s: coded service.unavailable, not a throw and not a success",
    async (_l, config, answer) => {
      if (answer) fetchMock.mockResolvedValue(answer);
      const r = await new CognitoAuthProvider(config).signOutEverywhere(SUB);
      expect(r).toMatchObject({ success: false, errorCode: "service.unavailable" });
    }
  );
});

describe("signOut revokes this session's refresh token only (ADR-057 D6)", () => {
  it("RevokeToken with the app client — never GlobalSignOut with the user's token", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    await new CognitoAuthProvider(CONFIG).signOut("", "refresh-1");
    expect(calls().map((c) => c.op)).toEqual(["RevokeToken"]);
    expect(calls()[0].body).toMatchObject({
      Token: "refresh-1",
      ClientId: CONFIG.clientId,
    });
  });

  it("no refresh token: nothing to revoke, no call", async () => {
    await new CognitoAuthProvider(CONFIG).signOut("access", undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("what was remembered of the user's tokens is void at once: the next verification asks Cognito again", async () => {
    const provider = new CognitoAuthProvider(CONFIG);
    const token = accessToken();
    fetchMock.mockResolvedValue(poolUser());
    await provider.verifyToken(token);
    await provider.verifyToken(token);
    expect(calls().map((c) => c.op)).toEqual(["AdminGetUser"]);
    fetchMock.mockReset().mockResolvedValueOnce(ok({}));
    await provider.signOut(token, "refresh-1");
    // Cognito now refuses the user (disabled, deleted): the remembered answer does not stand in.
    fetchMock.mockReset().mockResolvedValue(err("UserNotFoundException"));
    expect(await provider.verifyToken(token)).toBeNull();
    expect(calls().map((c) => c.op)).toEqual(["AdminGetUser"]);
  });

  it("hostile: a sign-out that did not revoke voids nothing, and throws", async () => {
    const provider = new CognitoAuthProvider(CONFIG);
    const token = accessToken();
    fetchMock.mockResolvedValueOnce(poolUser());
    await provider.verifyToken(token);
    fetchMock.mockReset().mockResolvedValueOnce(err("InternalErrorException", 500));
    await expect(provider.signOut(token, "refresh-1")).rejects.toThrow();
    fetchMock.mockReset();
    expect(await provider.verifyToken(token)).toMatchObject({ sub: SUB });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("disableMfa is administrative (ADR-057 D7)", () => {
  it("AdminSetUserMFAPreference, signed, by the user's id", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    expect(await new CognitoAuthProvider(CONFIG).disableMfa(SUB)).toEqual({
      success: true,
    });
    expect(calls()).toEqual([
      {
        op: "AdminSetUserMFAPreference",
        signed: true,
        body: {
          UserPoolId: CONFIG.userPoolId,
          Username: SUB,
          SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
        },
      },
    ]);
  });

  it.each([
    ["the key's policy lacks the action", CONFIG, err("AccessDeniedException")],
    ["there is no administrative key", KEYLESS, null],
  ])(
    "%s: service.unavailable — the factor stays on, and no user token is tried instead",
    async (_l, config, answer) => {
      if (answer) fetchMock.mockResolvedValue(answer);
      const r = await new CognitoAuthProvider(config).disableMfa(SUB);
      expect(r).toMatchObject({ success: false, errorCode: "service.unavailable" });
      expect(
        calls()
          .map((c) => c.op)
          .filter((op) => op === "SetUserMFAPreference")
      ).toEqual([]);
    }
  );
});

describe("renewSession (ADR-057 D3)", () => {
  const renewed = (sub: string, extra: Record<string, unknown> = {}) =>
    ok({
      AuthenticationResult: {
        AccessToken: accessToken(sub),
        IdToken: "id",
        ExpiresIn: 900,
        ...extra,
      },
    });

  it("renewed: the new access token, the same refresh token, the expiry Cognito gave", async () => {
    fetchMock.mockResolvedValueOnce(renewed(SUB));
    const before = Math.floor(Date.now() / 1000);
    const outcome = await new CognitoAuthProvider(CONFIG).renewSession("refresh-1", SUB);
    expect(outcome).toMatchObject({
      kind: "renewed",
      session: { userId: SUB, refreshToken: "refresh-1" },
    });
    if (outcome.kind !== "renewed") throw new Error("not renewed");
    expect(outcome.session.expiresAt).toBeGreaterThanOrEqual(before + 900);
    expect(outcome.session.expiresAt).toBeLessThanOrEqual(before + 902);
    expect(calls()[0]).toMatchObject({
      op: "InitiateAuth",
      body: {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: "refresh-1" },
      },
    });
  });

  it("with refresh-token rotation on, the new refresh token replaces the old", async () => {
    fetchMock.mockResolvedValueOnce(renewed(SUB, { RefreshToken: "refresh-2" }));
    expect(
      await new CognitoAuthProvider(CONFIG).renewSession("refresh-1", SUB)
    ).toMatchObject({
      session: { refreshToken: "refresh-2" },
    });
  });

  it.each([
    ["a revoked or expired refresh token", err("NotAuthorizedException")],
    ["a deleted user", err("UserNotFoundException")],
    ["a token that renews as someone else", renewed(OTHER)],
    ["an answer with no session", ok({})],
  ])("refused — %s: the session ends", async (_l, answer) => {
    fetchMock.mockResolvedValueOnce(answer);
    expect(await new CognitoAuthProvider(CONFIG).renewSession("refresh-1", SUB)).toEqual({
      kind: "refused",
    });
  });

  it.each([
    ["throttled", () => fetchMock.mockResolvedValueOnce(err("TooManyRequestsException"))],
    [
      "a server error",
      () => fetchMock.mockResolvedValueOnce(err("InternalErrorException", 500)),
    ],
    ["the network", () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))],
  ])("unavailable — %s: the session is kept", async (_l, arrange) => {
    arrange();
    expect(await new CognitoAuthProvider(CONFIG).renewSession("refresh-1", SUB)).toEqual({
      kind: "unavailable",
    });
  });

  it("nothing to renew with: refused without a call", async () => {
    const provider = new CognitoAuthProvider(CONFIG);
    expect(await provider.renewSession("", SUB)).toEqual({ kind: "refused" });
    expect(await provider.renewSession("refresh-1", "")).toEqual({ kind: "refused" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("confirmForgotPassword names whose password it was (ADR-057 D6)", () => {
  it("returns the account's subject, read with the administrative key, so its sessions can be ended", async () => {
    fetchMock.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(poolUser());
    const r = await new CognitoAuthProvider(CONFIG).confirmForgotPassword(
      "a@example.com",
      "123456",
      "N3w-password!"
    );
    expect(r).toMatchObject({ success: true, userId: SUB });
    expect(calls().map((c) => c.op)).toEqual(["ConfirmForgotPassword", "AdminGetUser"]);
  });

  it("the reset stands when the subject cannot be read (no key, or Cognito refuses): success without a userId", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(err("AccessDeniedException"));
    const r = await new CognitoAuthProvider(CONFIG).confirmForgotPassword(
      "a@example.com",
      "1",
      "p"
    );
    expect(r.success).toBe(true);
    expect(r.userId).toBeUndefined();
    fetchMock.mockReset().mockResolvedValueOnce(ok({}));
    const keyless = await new CognitoAuthProvider(KEYLESS).confirmForgotPassword(
      "a@example.com",
      "1",
      "p"
    );
    expect(keyless).toMatchObject({ success: true });
    expect(keyless.userId).toBeUndefined();
  });
});

describe("checkSessionAccess — operator readiness, 'sessions' (ADR-057 D7)", () => {
  const probe = () => new CognitoAuthProvider(CONFIG).checkSessionAccess();

  it("ready when the key may make all three calls (each answers 'no such user' for the probe name)", async () => {
    // As a real pool answers: a preference call that names no setting is malformed, and is
    // refused as such before the user is looked for (seen on a real pool, 2026-11-13).
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const op = String(headers["X-Amz-Target"] ?? headers["x-amz-target"]).replace(
        /^.*\./,
        ""
      );
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const noSetting =
        op === "AdminSetUserMFAPreference" &&
        !Object.keys(body).some((k) => k.endsWith("MfaSettings"));
      return err(noSetting ? "InvalidParameterException" : "UserNotFoundException");
    });
    expect(await probe()).toEqual({ state: "ready" });
    expect(calls().map((c) => [c.op, c.signed, c.body.Username])).toEqual([
      ["AdminGetUser", true, ERASURE_PROBE_USERNAME],
      ["AdminUserGlobalSignOut", true, ERASURE_PROBE_USERNAME],
      ["AdminSetUserMFAPreference", true, ERASURE_PROBE_USERNAME],
    ]);
    // The preference probe carries the real call's setting, and is sent only after AdminGetUser
    // answered that the probe name is no user's: nothing could change.
    expect(calls()[2].body).toEqual({
      UserPoolId: CONFIG.userPoolId,
      Username: ERASURE_PROBE_USERNAME,
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
    });
  });

  it.each(["AdminGetUser", "AdminUserGlobalSignOut", "AdminSetUserMFAPreference"])(
    "a policy without %s: denied, naming that action",
    async (missing) => {
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        const op = String(headers["X-Amz-Target"] ?? headers["x-amz-target"]).replace(
          /^.*\./,
          ""
        );
        return op === missing
          ? err("AccessDeniedException")
          : err("UserNotFoundException");
      });
      expect(await probe()).toMatchObject({ state: "denied", action: missing });
    }
  );

  it("no key: missing; Cognito not answering: unknown — neither is 'ready'", async () => {
    expect(await new CognitoAuthProvider(KEYLESS).checkSessionAccess()).toMatchObject({
      state: "missing",
    });
    fetchMock.mockResolvedValue(err("InternalErrorException", 500));
    expect(await probe()).toMatchObject({ state: "unknown" });
  });

  it("a probe call that succeeds proves nothing: unknown", async () => {
    fetchMock.mockResolvedValue(ok({}));
    expect(await probe()).toMatchObject({ state: "unknown" });
  });

  it("[hostile] the probe name is a user's: it stops at the read, and no preference call is sent", async () => {
    fetchMock.mockResolvedValue(ok({ Username: ERASURE_PROBE_USERNAME }));
    expect(await probe()).toMatchObject({ state: "unknown" });
    expect(calls().map((c) => c.op)).toEqual(["AdminGetUser"]);
  });
});
