/**
 * CognitoAuthProvider Tests — integrity tests with mocked Cognito API.
 *
 * Tests sign-in, sign-up, token verification, password flows, MFA,
 * guest mode, error mapping, and resilience (timeout, network failure).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { CognitoAuthProvider, CognitoError } from "@/platform/auth/cognito-provider";
import type { CognitoConfig } from "@/platform/auth/cognito-provider";

const TEST_CONFIG: CognitoConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  timeoutMs: 5000,
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
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
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

  it("returns friendly error for invalid credentials", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Incorrect username or password.")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.signIn("test@example.com", "wrong");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid email or password");
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
    expect(result.error).toContain("already exists");
  });
});

describe("CognitoAuthProvider — verifyToken", () => {
  it("returns payload for valid token", async () => {
    const accessToken = fakeJwt({ sub: "user-123", iat: 1000, exp: 9999 });
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        Username: "user-123",
        UserAttributes: [
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
});

describe("CognitoAuthProvider — resilience", () => {
  it("signOut does not throw on Cognito failure (P6)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    // Should not throw
    await provider.signOut("some-token");
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
    expect(result.error).toContain("Too many attempts");
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
