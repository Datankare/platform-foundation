/**
 * CognitoAuthProvider Tests — integrity tests with mocked Cognito API.
 *
 * Tests sign-in, sign-up, token verification, password flows, MFA,
 * guest mode, error mapping, and resilience (timeout, network failure).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { getCache } from "@/platform/cache";
import { createHmac } from "node:crypto";
import {
  CognitoAuthProvider,
  CognitoError,
  secretHash,
} from "@/platform/auth/cognito-provider";
import type { CognitoConfig } from "@/platform/auth/cognito-provider";
import { TEST_JWKS, signJwt } from "./helpers/test-jwt";

const TEST_CONFIG: CognitoConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  timeoutMs: 5000,
  jwks: TEST_JWKS,
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

function cognitoOk(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

function cognitoError(type: string, message: string, status = 400) {
  return {
    ok: false,
    status,
    json: async () => ({ __type: type, message }),
  };
}

// Fake JWT with decodable payload
// Signed as the pool signs (review 8 M5: the provider checks the signature before GetUser).
function fakeJwt(payload: Record<string, unknown>): string {
  return signJwt(payload);
}

/** An access token this app client would be issued (audit A-3: GetUser alone is not enough). */
function accessJwt(extra: Record<string, unknown> = {}): string {
  return fakeJwt({
    sub: "user-123",
    token_use: "access",
    client_id: TEST_CONFIG.clientId,
    iss: `https://cognito-idp.${TEST_CONFIG.region}.amazonaws.com/${TEST_CONFIG.userPoolId}`,
    iat: 1000,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  });
}

describe("CognitoAuthProvider — signIn", () => {
  it("returns success with tokens on valid credentials", async () => {
    const accessToken = fakeJwt({ sub: "user-123", email: "test@example.com" });
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        AuthenticationResult: {
          AccessToken: accessToken,
          RefreshToken: "refresh-tok",
          IdToken: "id-tok",
          ExpiresIn: 3600,
        },
      })
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("test@example.com", "password");

    expect(result.success).toBe(true);
    expect(result.userId).toBe("user-123");
    expect(result.accessToken).toBe(accessToken);
    expect(result.refreshToken).toBe("refresh-tok");
    expect(result.expiresIn).toBe(3600);
  });

  it("returns mfaRequired when Cognito sends MFA challenge", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        Session: "mfa-session-123",
      })
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("test@example.com", "password");

    expect(result.success).toBe(false);
    expect(result.mfaRequired).toBe(true);
    expect(result.mfaSession).toBe("mfa-session-123");
  });

  it("returns newPasswordRequired when Cognito sends NEW_PASSWORD_REQUIRED", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: "new-pass-session-123",
      })
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("test@example.com", "TempPass1!");

    expect(result.success).toBe(false);
    expect(result.newPasswordRequired).toBe(true);
    expect(result.challengeSession).toBe("new-pass-session-123");
  });

  it("returns an error when the new-password response has no tokens", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.respondToNewPasswordChallenge(
      "new-pass-session-123",
      "NewStrongPass123!",
      "test@example.com"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Password change failed");
  });

  it("returns friendly error for invalid credentials", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Incorrect username or password.")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("test@example.com", "wrong");

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("auth.invalid_credentials");
  });

  it("returns emailVerificationRequired for unconfirmed user", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("UserNotConfirmedException", "User is not confirmed.")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("test@example.com", "password");

    expect(result.success).toBe(false);
    expect(result.emailVerificationRequired).toBe(true);
  });
});

describe("CognitoAuthProvider — signUp", () => {
  it("returns success with userId", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoOk({ UserSub: "new-user-456", UserConfirmed: false })
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signUp("new@example.com", "SecurePass1!");

    expect(result.success).toBe(true);
    expect(result.userId).toBe("new-user-456");
    expect(result.emailVerificationRequired).toBe(true);
  });

  it("returns error for existing email", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("UsernameExistsException", "User already exists")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signUp("existing@example.com", "Pass1!");

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("auth.account_exists");
  });
});

describe("CognitoAuthProvider — verifyToken", () => {
  it("returns payload for valid token", async () => {
    const accessToken = accessJwt();
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        Username: "user-123",
        UserAttributes: [
          { Name: "sub", Value: "user-123" },
          { Name: "email", Value: "test@example.com" },
          { Name: "email_verified", Value: "true" },
        ],
      })
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const payload = await provider.verifyToken(accessToken);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("user-123");
    expect(payload!.email).toBe("test@example.com");
    expect(payload!.emailVerified).toBe(true);
  });

  it.each([
    [
      "reports origin_jti as the sign-in session (PF v5.1.0)",
      { origin_jti: "origin-1" },
      "origin-1",
    ],
    ["reports no session without origin_jti", {}, undefined],
    ["reports no session for an empty origin_jti", { origin_jti: "" }, undefined],
  ])("%s", async (_label, extra, expected) => {
    const accessToken = accessJwt(extra);
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        Username: "user-123",
        UserAttributes: [
          { Name: "sub", Value: "user-123" },
          { Name: "email", Value: "test@example.com" },
        ],
      })
    );
    const payload = await new CognitoAuthProvider(TEST_CONFIG).verifyToken(accessToken);
    expect(payload?.sessionId).toBe(expected);
  });

  it("warns once — not per request — when tokens carry no origin_jti (revocation off)", async () => {
    const { logger } = jest.requireMock("@/lib/logger");
    const before = (logger.warn as jest.Mock).mock.calls.filter(([m]: [string]) =>
      m.includes("origin_jti")
    ).length;
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(
        cognitoOk({
          Username: "user-123",
          UserAttributes: [{ Name: "sub", Value: "user-123" }],
        })
      );
      await new CognitoAuthProvider(TEST_CONFIG).verifyToken(accessJwt());
    }
    const after = (logger.warn as jest.Mock).mock.calls.filter(([m]: [string]) =>
      m.includes("origin_jti")
    ).length;
    expect(after).toBe(1);
    expect(before).toBeLessThanOrEqual(1);
  });

  it("returns null for invalid token", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Invalid Access Token")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const payload = await provider.verifyToken("bad-token");

    expect(payload).toBeNull();
  });
});

describe("CognitoAuthProvider — refreshToken", () => {
  it("returns new session on successful refresh", async () => {
    const newAccess = fakeJwt({ sub: "user-123" });
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        AuthenticationResult: {
          AccessToken: newAccess,
          IdToken: "new-id-tok",
          ExpiresIn: 3600,
        },
      })
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const session = await provider.refreshToken("valid-refresh-token");

    expect(session).not.toBeNull();
    expect(session!.accessToken).toBe(newAccess);
    expect(session!.refreshToken).toBe("valid-refresh-token");
    expect(session!.expiresAt).toBeGreaterThan(0);
  });

  it("returns null on expired refresh token", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Refresh token expired")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const session = await provider.refreshToken("expired-token");

    expect(session).toBeNull();
  });
});

describe("CognitoAuthProvider — password flows", () => {
  it("forgotPassword sends reset code", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.forgotPassword("test@example.com");

    expect(result.success).toBe(true);
    expect(result.deliveryMedium).toBe("email");
  });

  it("confirmForgotPassword resets password", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.confirmForgotPassword(
      "test@example.com",
      "123456",
      "NewPass1!"
    );

    expect(result.success).toBe(true);
  });

  it("changePassword succeeds", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.changePassword("token", "old", "new");

    expect(result.success).toBe(true);
  });
});

describe("CognitoAuthProvider — email verification", () => {
  it("confirms email", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.confirmEmailVerification("test@example.com", "123456");

    expect(result.success).toBe(true);
  });

  it("resends verification code", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.resendEmailVerification("test@example.com");

    expect(result.success).toBe(true);
  });

  it("returns error for invalid code", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("CodeMismatchException", "Invalid verification code")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.confirmEmailVerification("test@example.com", "000000");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid verification code");
  });
});

describe("CognitoAuthProvider — guest mode", () => {
  it("creates guest token with valid fields", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.createGuestToken();

    expect(result.success).toBe(true);
    expect(result.guestId).toMatch(/^guest_/);
    expect(result.token).toMatch(/^guest\./);
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("verifies valid guest token", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const created = await provider.createGuestToken();
    const verified = await provider.verifyGuestToken(created.token);

    expect(verified.valid).toBe(true);
    expect(verified.guestId).toBe(created.guestId);
  });

  it("rejects invalid guest token", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.verifyGuestToken("not-a-guest-token");

    expect(result.valid).toBe(false);
  });

  it("rejects expired guest token", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const expiredPayload = Buffer.from(
      JSON.stringify({ sub: "guest_old", type: "guest", iat: 0, exp: 1 })
    ).toString("base64url");

    const result = await provider.verifyGuestToken(`guest.${expiredPayload}`);
    expect(result.valid).toBe(false);
  });

  it("rejects an unsigned, unexpired guest token — forgery (ADR-050 D4, TASK-098)", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const forged = Buffer.from(
      JSON.stringify({
        sub: "guest_00000000000000000000000000000000",
        type: "guest",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");

    const result = await provider.verifyGuestToken(`guest.${forged}`);
    expect(result.valid).toBe(false);
  });
});

describe("CognitoAuthProvider — resilience", () => {
  it("signOut reports a revocation that failed — never a sign-out that revoked nothing (X-17)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    await expect(provider.signOut("some-token")).rejects.toThrow("Network down");
  });

  it("verifyToken returns null on network failure (P6)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.verifyToken("some-token");

    expect(result).toBeNull();
  });

  it("listDevices returns empty on failure (P6)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.listDevices("some-token");

    expect(result).toEqual([]);
  });

  it("handles rate limiting gracefully", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("TooManyRequestsException", "Rate exceeded")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("test@example.com", "password");

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("auth.too_many_attempts");
  });
});

describe("CognitoError", () => {
  it("has correct properties", () => {
    const err = new CognitoError("test message", "TestType", 400);
    expect(err.message).toBe("test message");
    expect(err.cognitoType).toBe("TestType");
    expect(err.statusCode).toBe(400);
    expect(err.name).toBe("CognitoError");
  });
});

describe("CognitoAuthProvider — error codes (ADR-051)", () => {
  it.each([
    ["UserNotFoundException", "auth.invalid_credentials"],
    ["NotAuthorizedException", "auth.invalid_credentials"],
    ["UsernameExistsException", "auth.account_exists"],
    ["InvalidPasswordException", "auth.password_policy"],
    ["CodeMismatchException", "auth.code_invalid"],
    ["ExpiredCodeException", "auth.code_expired"],
    ["LimitExceededException", "auth.too_many_attempts"],
    ["InvalidParameterException", "request.invalid_body"],
    ["SomethingNewException", "internal.error"],
  ])("%s → %s", async (type, code) => {
    mockFetch.mockResolvedValueOnce(cognitoError(type, "raw cognito text"));
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("a@b.c", "x");
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(code);
  });

  it("an unconfirmed account is the verification step", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("UserNotConfirmedException", "not confirmed")
    );
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("a@b.c", "x");
    expect(result.errorCode).toBe("auth.email_not_verified");
    expect(result.emailVerificationRequired).toBe(true);
  });

  it("other operations code their failures too", async () => {
    mockFetch.mockResolvedValueOnce(cognitoError("CodeMismatchException", "bad code"));
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.confirmForgotPassword(
      "a@b.c",
      "000000",
      "N3w!Passw0rd#"
    );
    expect(result.errorCode).toBe("auth.code_invalid");
  });
});

describe("CognitoAuthProvider — whose token it is (audit A-3)", () => {
  const getUserOk = () =>
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        Username: "user-123",
        UserAttributes: [
          { Name: "sub", Value: "user-123" },
          { Name: "email", Value: "test@example.com" },
        ],
        UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
      })
    );

  it.each([
    ["another app client's token (a shared pool)", { client_id: "other-client" }],
    ["an ID token", { token_use: "id" }],
    ["a token with no token_use", { token_use: undefined }],
    [
      "another pool's token",
      { iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other" },
    ],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 1 }],
    ["a token with no expiry", { exp: undefined }],
  ])("refuses %s even though GetUser accepted it", async (_label, extra) => {
    getUserOk();
    const payload = await new CognitoAuthProvider(TEST_CONFIG).verifyToken(
      accessJwt(extra)
    );
    expect(payload).toBeNull();
  });

  it("refuses an undecodable token", async () => {
    getUserOk();
    expect(await new CognitoAuthProvider(TEST_CONFIG).verifyToken("opaque")).toBeNull();
  });

  it("accepts this client's access token and reports its second factor (A-9)", async () => {
    getUserOk();
    const payload = await new CognitoAuthProvider(TEST_CONFIG).verifyToken(accessJwt());
    expect(payload).toMatchObject({ sub: "user-123", mfaEnabled: true });
  });

  it("TASK-177: the subject is the token's sub — a federated user's too, never its username (Google_…) — and its providers say who verified the address", async () => {
    const SUB = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const getUser = {
      Username: "Google_109320000000000000001",
      UserAttributes: [
        { Name: "sub", Value: SUB },
        { Name: "email", Value: "staff@example.com" },
        { Name: "email_verified", Value: "true" },
        {
          Name: "identities",
          Value: JSON.stringify([{ providerName: "Google", userId: "1093" }]),
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(cognitoOk(getUser));
    const payload = await new CognitoAuthProvider(TEST_CONFIG).verifyToken(
      accessJwt({ sub: SUB, username: "Google_109320000000000000001" })
    );
    expect(payload).toMatchObject({
      sub: SUB,
      emailVerified: true,
      identityProviders: ["Google"],
    });
    // getUserInfo names the same subject.
    mockFetch.mockResolvedValueOnce(cognitoOk(getUser));
    await expect(
      new CognitoAuthProvider(TEST_CONFIG).getUserInfo(accessJwt({ sub: SUB }))
    ).resolves.toEqual({ userId: SUB, email: "staff@example.com", emailVerified: true });
  });

  it("TASK-177: a GetUser answer for another sub than the token's is never that token's", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        Username: "Google_1",
        UserAttributes: [{ Name: "sub", Value: "00000000-0000-4000-8000-000000000000" }],
      })
    );
    expect(
      await new CognitoAuthProvider(TEST_CONFIG).verifyToken(
        accessJwt({ sub: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", username: "Google_1" })
      )
    ).toBeNull();
  });

  it("TASK-177: a token without a sub names nobody — its username is never taken instead", async () => {
    const token = fakeJwt({
      username: "Google_1093",
      token_use: "access",
      client_id: TEST_CONFIG.clientId,
      iss: `https://cognito-idp.${TEST_CONFIG.region}.amazonaws.com/${TEST_CONFIG.userPoolId}`,
      iat: 1000,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(await new CognitoAuthProvider(TEST_CONFIG).verifyToken(token)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports no second factor when the user has none", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        Username: "user-123",
        UserAttributes: [{ Name: "sub", Value: "user-123" }],
      })
    );
    const payload = await new CognitoAuthProvider(TEST_CONFIG).verifyToken(accessJwt());
    expect(payload?.mfaEnabled).toBe(false);
  });
});

describe("CognitoAuthProvider — a confidential app client (audit A-7)", () => {
  const SECRET = "s3cr3t".repeat(8);
  const CONFIDENTIAL: CognitoConfig = { ...TEST_CONFIG, clientSecret: SECRET };
  const expected = (username: string) =>
    createHmac("sha256", SECRET)
      .update(username + TEST_CONFIG.clientId)
      .digest("base64");
  const sent = (i = 0) => JSON.parse(mockFetch.mock.calls[i][1].body as string);

  beforeEach(() => mockFetch.mockResolvedValue(cognitoOk({})));

  it("computes Cognito's SECRET_HASH, and none for a public client", () => {
    expect(secretHash(CONFIDENTIAL, "a@b.c")).toBe(expected("a@b.c"));
    expect(secretHash(TEST_CONFIG, "a@b.c")).toBeUndefined();
  });

  it.each([
    ["signUp", (p: CognitoAuthProvider) => p.signUp("a@b.c", "pw"), "SecretHash"],
    [
      "forgotPassword",
      (p: CognitoAuthProvider) => p.forgotPassword("a@b.c"),
      "SecretHash",
    ],
    [
      "confirmForgotPassword",
      (p: CognitoAuthProvider) => p.confirmForgotPassword("a@b.c", "1", "pw"),
      "SecretHash",
    ],
    [
      "confirmEmailVerification",
      (p: CognitoAuthProvider) => p.confirmEmailVerification("a@b.c", "1"),
      "SecretHash",
    ],
    [
      "resendEmailVerification",
      (p: CognitoAuthProvider) => p.resendEmailVerification("a@b.c"),
      "SecretHash",
    ],
  ])("%s sends the hash for the user", async (_label, call, field) => {
    await call(new CognitoAuthProvider(CONFIDENTIAL));
    expect(sent()[field]).toBe(expected("a@b.c"));
  });

  it("sign-in, the challenges and refresh carry it in their parameters", async () => {
    const provider = new CognitoAuthProvider(CONFIDENTIAL);
    await provider.signIn("a@b.c", "pw");
    expect(sent(0).AuthParameters.SECRET_HASH).toBe(expected("a@b.c"));
    await provider.respondToMfaChallenge("sess", "123456", "a@b.c");
    expect(sent(1).ChallengeResponses).toMatchObject({
      USERNAME: "a@b.c",
      SECRET_HASH: expected("a@b.c"),
    });
    await provider.respondToNewPasswordChallenge("sess", "pw", "a@b.c");
    expect(sent(2).ChallengeResponses.SECRET_HASH).toBe(expected("a@b.c"));
    await provider.refreshToken("refresh", "user-123");
    expect(sent(3).AuthParameters.SECRET_HASH).toBe(expected("user-123"));
  });

  it("does not try a refresh it cannot hash (no user id)", async () => {
    expect(
      await new CognitoAuthProvider(CONFIDENTIAL).refreshToken("refresh")
    ).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses a refreshed session for another user", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        AuthenticationResult: {
          AccessToken: fakeJwt({ sub: "someone-else" }),
          ExpiresIn: 60,
        },
      })
    );
    expect(
      await new CognitoAuthProvider(CONFIDENTIAL).refreshToken("refresh", "user-123")
    ).toBeNull();
  });

  it("signs out everywhere first, then revokes the refresh token with the client secret (X-17, review 17 M1)", async () => {
    await new CognitoAuthProvider(CONFIDENTIAL).signOut("access", "refresh");
    // GlobalSignOut first: RevokeToken would void the access token it is asked with.
    expect(mockFetch.mock.calls[0][1].headers["X-Amz-Target"]).toMatch(/GlobalSignOut$/);
    expect(mockFetch.mock.calls[1][1].headers["X-Amz-Target"]).toMatch(/RevokeToken$/);
    expect(sent(1)).toEqual({
      ClientId: TEST_CONFIG.clientId,
      Token: "refresh",
      ClientSecret: SECRET,
    });
  });

  it("treats an expired access token as signed out once its refresh token is revoked", async () => {
    mockFetch
      .mockResolvedValueOnce(
        cognitoError("NotAuthorizedException", "Access Token has expired")
      )
      .mockResolvedValueOnce(cognitoOk({}));
    await expect(
      new CognitoAuthProvider(CONFIDENTIAL).signOut("expired", "refresh")
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("a refresh token GlobalSignOut already voided is signed out; one that could not be revoked after an expired token is reported", async () => {
    mockFetch
      .mockResolvedValueOnce(cognitoOk({}))
      .mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Token revoked"));
    await expect(
      new CognitoAuthProvider(CONFIDENTIAL).signOut("access", "refresh")
    ).resolves.toBeUndefined();
    mockFetch
      .mockResolvedValueOnce(cognitoError("NotAuthorizedException", "expired"))
      .mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Invalid token"));
    await expect(
      new CognitoAuthProvider(CONFIDENTIAL).signOut("expired", "refresh")
    ).rejects.toThrow();
    mockFetch
      .mockResolvedValueOnce(cognitoOk({}))
      .mockResolvedValueOnce(cognitoError("InternalErrorException", "down", 500));
    await expect(
      new CognitoAuthProvider(CONFIDENTIAL).signOut("access", "refresh")
    ).rejects.toThrow();
  });

  it("reports an expired access token with no refresh token revoked", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Access Token has expired")
    );
    await expect(
      new CognitoAuthProvider(CONFIDENTIAL).signOut("expired")
    ).rejects.toThrow();
  });

  it("authenticates at the token endpoint with the secret", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoOk({ access_token: fakeJwt({ sub: "u" }), refresh_token: "r" })
    );
    await new CognitoAuthProvider({
      ...CONFIDENTIAL,
      hostedUiDomain: "x.auth.us-east-1.amazoncognito.com",
    }).handleSsoCallback("google", "code", "https://app.example/auth/callback");
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe(
      `Basic ${Buffer.from(`${TEST_CONFIG.clientId}:${SECRET}`).toString("base64")}`
    );
  });
});

describe("CognitoAuthProvider — MFA and SSO (audit A-9, A-13)", () => {
  it("answers the MFA challenge for the user it was issued to, never a placeholder", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));
    await new CognitoAuthProvider(TEST_CONFIG).respondToMfaChallenge(
      "sess",
      "123456",
      "person@example.com"
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.ChallengeResponses.USERNAME).toBe("person@example.com");
  });

  it("asks hosted sign-in for the scope GetUser needs, so SSO users are not refused", async () => {
    const result = await new CognitoAuthProvider({
      ...TEST_CONFIG,
      hostedUiDomain: "x.auth.us-east-1.amazoncognito.com",
    }).initiateSso("google", "https://app.example/auth/callback");
    const scope = new URL(result.redirectUrl!).searchParams.get("scope")!.split(" ");
    expect(scope).toEqual(
      expect.arrayContaining(["openid", "aws.cognito.signin.user.admin"])
    );
  });
});

describe("CognitoAuthProvider.verifyToken against the GetUser quota", () => {
  const getUserOk = () =>
    cognitoOk({
      Username: "user-123",
      UserAttributes: [
        { Name: "sub", Value: "user-123" },
        { Name: "email", Value: "a@b.c" },
      ],
      UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
    });

  it("refuses a foreign or expired token before any call to Cognito", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    expect(await provider.verifyToken(accessJwt({ exp: 1 }))).toBeNull();
    expect(await provider.verifyToken(accessJwt({ client_id: "other" }))).toBeNull();
    expect(await provider.verifyToken("not-a-jwt")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("asks GetUser once for a token used twice in its window", async () => {
    mockFetch.mockResolvedValue(getUserOk());
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const token = accessJwt({ jti: "once" });
    expect(await provider.verifyToken(token)).toMatchObject({ sub: "user-123" });
    expect(await provider.verifyToken(token)).toMatchObject({ sub: "user-123" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a throttled GetUser is never read as an invalid token: privileged fails closed", async () => {
    mockFetch.mockResolvedValue(
      cognitoError("TooManyRequestsException", "Rate exceeded")
    );
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    await expect(
      provider.verifyToken(accessJwt({ jti: "throttled" }), { privileged: true })
    ).rejects.toThrow(/token verification unavailable: TooManyRequestsException/);
    await expect(provider.verifyToken(accessJwt({ jti: "throttled-2" }))).rejects.toThrow(
      /unavailable/
    );
  });

  it("a revoked token (NotAuthorizedException) is invalid", async () => {
    mockFetch.mockResolvedValue(
      cognitoError("NotAuthorizedException", "Access Token has been revoked")
    );
    expect(
      await new CognitoAuthProvider(TEST_CONFIG).verifyToken(
        accessJwt({ jti: "revoked" })
      )
    ).toBeNull();
  });
});
