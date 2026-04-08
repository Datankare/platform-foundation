/**
 * CognitoAuthProvider — additional coverage for SSO, devices, userInfo,
 * deleteUser, changePassword errors, and config from env.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  CognitoAuthProvider,
  getCognitoConfigFromEnv,
} from "@/platform/auth/cognito-provider";
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
  return { ok: false, status, json: async () => ({ __type: type, message }) };
}

describe("getCognitoConfigFromEnv", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("reads from COGNITO env vars", () => {
    process.env.COGNITO_REGION = "eu-west-1";
    process.env.COGNITO_USER_POOL_ID = "eu-west-1_Pool";
    process.env.COGNITO_CLIENT_ID = "my-client";

    const config = getCognitoConfigFromEnv();
    expect(config.region).toBe("eu-west-1");
    expect(config.userPoolId).toBe("eu-west-1_Pool");
    expect(config.clientId).toBe("my-client");
  });

  it("falls back to AWS_REGION", () => {
    delete process.env.COGNITO_REGION;
    process.env.AWS_REGION = "ap-southeast-1";
    process.env.COGNITO_USER_POOL_ID = "pool";
    process.env.COGNITO_CLIENT_ID = "client";

    const config = getCognitoConfigFromEnv();
    expect(config.region).toBe("ap-southeast-1");
  });

  it("defaults to us-east-1 when no region env", () => {
    delete process.env.COGNITO_REGION;
    delete process.env.AWS_REGION;
    process.env.COGNITO_USER_POOL_ID = "pool";
    process.env.COGNITO_CLIENT_ID = "client";

    const config = getCognitoConfigFromEnv();
    expect(config.region).toBe("us-east-1");
  });

  it("warns when config is incomplete", () => {
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    const { logger } = jest.requireMock("@/lib/logger");
    getCognitoConfigFromEnv();
    expect(logger.warn).toHaveBeenCalledWith(
      "Cognito config incomplete",
      expect.any(Object)
    );
  });
});

describe("CognitoAuthProvider — SSO", () => {
  it("initiateSso returns redirect URL for Google", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.initiateSso("google", "https://app.com/callback");

    expect(result.success).toBe(true);
    expect(result.redirectUrl).toContain("oauth2/authorize");
    expect(result.redirectUrl).toContain("identity_provider=Google");
    expect(result.redirectUrl).toContain("client_id=test-client-id");
  });

  it("initiateSso returns redirect URL for Apple", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.initiateSso("apple", "https://app.com/callback");

    expect(result.redirectUrl).toContain("identity_provider=SignInWithApple");
  });

  it("initiateSso returns redirect URL for Microsoft", async () => {
    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.initiateSso("microsoft", "https://app.com/callback");

    expect(result.redirectUrl).toContain("identity_provider=Microsoft");
  });

  it("handleSsoCallback exchanges code for tokens", async () => {
    const fakeJwt =
      "h." +
      Buffer.from(JSON.stringify({ sub: "sso-user" })).toString("base64url") +
      ".s";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: fakeJwt,
        refresh_token: "sso-refresh",
        id_token: "sso-id",
        expires_in: 3600,
      }),
    });

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.handleSsoCallback(
      "google",
      "auth-code-123",
      "https://app.com/callback"
    );

    expect(result.success).toBe(true);
    expect(result.userId).toBe("sso-user");
    expect(result.accessToken).toBe(fakeJwt);
  });

  it("handleSsoCallback returns error on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.handleSsoCallback(
      "google",
      "bad-code",
      "https://app.com/cb"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("SSO token exchange failed");
  });

  it("handleSsoCallback returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.handleSsoCallback(
      "google",
      "code",
      "https://app.com/cb"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network down");
  });
});

describe("CognitoAuthProvider — devices", () => {
  it("listDevices returns device list", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoOk({
        Devices: [
          {
            DeviceKey: "device-1",
            DeviceAttributes: [{ Name: "device_name", Value: "iPhone" }],
            DeviceLastAuthenticatedDate: "2026-04-01",
          },
        ],
      })
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const devices = await provider.listDevices("token");

    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe("device-1");
    expect(devices[0].deviceName).toBe("iPhone");
  });

  it("forgetDevice succeeds", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.forgetDevice("token", "device-1");

    expect(result.success).toBe(true);
  });

  it("forgetDevice returns error on failure", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("ResourceNotFoundException", "Device not found")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.forgetDevice("token", "bad-device");

    expect(result.success).toBe(false);
  });
});

describe("CognitoAuthProvider — userInfo and deleteUser", () => {
  it("getUserInfo returns user attributes", async () => {
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
    const info = await provider.getUserInfo("token");

    expect(info).not.toBeNull();
    expect(info!.email).toBe("test@example.com");
    expect(info!.emailVerified).toBe(true);
  });

  it("getUserInfo returns null on failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const info = await provider.getUserInfo("bad-token");

    expect(info).toBeNull();
  });

  it("deleteUser succeeds", async () => {
    mockFetch.mockResolvedValueOnce(cognitoOk({}));

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.deleteUser("token");

    expect(result.success).toBe(true);
  });

  it("deleteUser returns error on failure", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Token expired")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.deleteUser("expired-token");

    expect(result.success).toBe(false);
  });
});

describe("CognitoAuthProvider — password error paths", () => {
  it("forgotPassword returns error", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("UserNotFoundException", "User does not exist")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.forgotPassword("unknown@example.com");

    expect(result.success).toBe(false);
  });

  it("confirmForgotPassword returns error for bad code", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("CodeMismatchException", "Invalid code")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.confirmForgotPassword(
      "test@example.com",
      "000",
      "NewPass!"
    );

    expect(result.success).toBe(false);
  });

  it("changePassword returns error for wrong old password", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Incorrect password")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.changePassword("token", "wrong", "new");

    expect(result.success).toBe(false);
  });
});

describe("CognitoAuthProvider — MFA error paths", () => {
  it("setupMfa returns error", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Invalid token")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.setupMfa("bad-token");

    expect(result.success).toBe(false);
  });

  it("verifyMfaSetup returns error for wrong code", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("EnableSoftwareTokenMFAException", "Invalid code")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.verifyMfaSetup("token", "000000");

    expect(result.success).toBe(false);
  });

  it("disableMfa returns error", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Invalid token")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.disableMfa("bad-token");

    expect(result.success).toBe(false);
  });
});

describe("CognitoAuthProvider — email verification errors", () => {
  it("resendEmailVerification returns error", async () => {
    mockFetch.mockResolvedValueOnce(
      cognitoError("LimitExceededException", "Too many attempts")
    );

    const provider = new CognitoAuthProvider(TEST_CONFIG);
    const result = await provider.resendEmailVerification("test@example.com");

    expect(result.success).toBe(false);
  });
});
