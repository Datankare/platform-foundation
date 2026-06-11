/**
 * Auth provider contract — PF reference Cognito arm (ADR-027).
 *
 * Runs the synced AuthProvider conformance kit against the real
 * CognitoAuthProvider, with the Cognito REST API stubbed by an action router.
 * This is the consumer-reimplemented abstraction, so a contract change in the
 * kit re-runs here and fails if the real impl no longer conforms — the tripwire
 * the whole convention exists for. Playform mirrors this with its own arm.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  runAuthProviderContract,
  AUTH_CONTRACT,
  type AuthContractFixtures,
} from "./contract/auth-provider-contract";
import {
  CognitoAuthProvider,
  type CognitoConfig,
} from "@/platform/auth/cognito-provider";

const C = AUTH_CONTRACT;

const TEST_CONFIG: CognitoConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  timeoutMs: 5000,
};

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

const VALID_ACCESS_TOKEN = fakeJwt({
  sub: "user-123",
  email: C.email,
  iat: 1000,
  exp: 9_999_999_999,
});

const nowSec = Math.floor(Date.now() / 1000);
const VALID_GUEST_TOKEN =
  "guest." +
  Buffer.from(
    JSON.stringify({
      sub: "guest_contract",
      type: "guest",
      iat: nowSec,
      exp: nowSec + 3600,
    })
  ).toString("base64url");

interface CognitoPayload {
  AuthFlow?: string;
  AuthParameters?: {
    PASSWORD?: string;
    USERNAME?: string;
    REFRESH_TOKEN?: string;
  };
  AccessToken?: string;
  PreviousPassword?: string;
  ChallengeName?: string;
  ChallengeResponses?: {
    SOFTWARE_TOKEN_MFA_CODE?: string;
    NEW_PASSWORD?: string;
    USERNAME?: string;
  };
}

function ok(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

function errBody(type: string, message: string, status = 400) {
  return { ok: false, status, json: async () => ({ __type: type, message }) };
}

function authResult(sub = "user-123") {
  return {
    AuthenticationResult: {
      AccessToken: fakeJwt({ sub }),
      RefreshToken: "refresh-tok",
      IdToken: "id-tok",
      ExpiresIn: 3600,
    },
  };
}

function routeCognito(action: string, payload: CognitoPayload) {
  switch (action) {
    case "SignUp":
      return ok({ UserSub: "new-user-456", UserConfirmed: false });

    case "InitiateAuth": {
      if (payload.AuthFlow === "REFRESH_TOKEN_AUTH") {
        return ok({
          AuthenticationResult: {
            AccessToken: fakeJwt({ sub: "user-123" }),
            IdToken: "id-tok",
            ExpiresIn: 3600,
          },
        });
      }
      const pw = payload.AuthParameters?.PASSWORD;
      if (pw === C.mfaPassword) {
        return ok({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "mfa-session-1" });
      }
      if (pw === C.newPasswordTrigger) {
        return ok({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "newpw-session-1" });
      }
      if (pw === C.wrongPassword) {
        return errBody("NotAuthorizedException", "Incorrect username or password.");
      }
      return ok(authResult());
    }

    case "GetUser":
      if (payload.AccessToken === VALID_ACCESS_TOKEN) {
        return ok({
          Username: "user-123",
          UserAttributes: [
            { Name: "email", Value: C.email },
            { Name: "email_verified", Value: "true" },
          ],
        });
      }
      return errBody("NotAuthorizedException", "Invalid Access Token");

    case "ChangePassword":
      if (payload.PreviousPassword === C.wrongPassword) {
        return errBody("NotAuthorizedException", "Incorrect password");
      }
      return ok({});

    case "AssociateSoftwareToken":
      return ok({ SecretCode: "MOCKSECRET123" });

    case "RespondToAuthChallenge": {
      if (payload.ChallengeName === "SOFTWARE_TOKEN_MFA") {
        if (payload.ChallengeResponses?.SOFTWARE_TOKEN_MFA_CODE === C.totpCode) {
          return ok(authResult());
        }
        return errBody("CodeMismatchException", "Invalid code");
      }
      if (payload.ChallengeName === "NEW_PASSWORD_REQUIRED") {
        if (payload.ChallengeResponses?.NEW_PASSWORD === C.weakPassword) {
          return errBody(
            "InvalidPasswordException",
            "Password does not meet requirements"
          );
        }
        return ok(authResult());
      }
      return ok(authResult());
    }

    case "ListDevices":
      return ok({
        Devices: [
          {
            DeviceKey: "dev-1",
            DeviceAttributes: [{ Name: "device_name", Value: "Test Device" }],
            DeviceLastAuthenticatedDate: "2026-01-01T00:00:00Z",
          },
        ],
      });

    case "GlobalSignOut":
    case "ForgotPassword":
    case "ConfirmForgotPassword":
    case "ConfirmSignUp":
    case "ResendConfirmationCode":
    case "VerifySoftwareToken":
    case "SetUserMFAPreference":
    case "ForgetDevice":
    case "DeleteUser":
      return ok({});

    default:
      return ok({});
  }
}

const originalFetch = global.fetch;

beforeAll(() => {
  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      // SSO token exchange uses the hosted-UI domain, not the cognito-idp endpoint.
      if (url.includes("/oauth2/token")) {
        return ok({
          access_token: fakeJwt({ sub: "sso-user" }),
          refresh_token: "sso-refresh",
          id_token: "sso-id",
          expires_in: 3600,
        }) as unknown as Response;
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const action = (headers["X-Amz-Target"] ?? "").split(".")[1] ?? "";
      const payload = init?.body
        ? (JSON.parse(String(init.body)) as CognitoPayload)
        : ({} as CognitoPayload);
      return routeCognito(action, payload) as unknown as Response;
    }
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

const cognitoFixtures: AuthContractFixtures = {
  makeProvider: () => new CognitoAuthProvider(TEST_CONFIG),
  validAccessToken: VALID_ACCESS_TOKEN,
  invalidAccessToken: "invalid-token",
  validRefreshToken: "valid-refresh-token",
  mfaSession: "mfa-session-1",
  newPasswordSession: "newpw-session-1",
  validGuestToken: VALID_GUEST_TOKEN,
  invalidGuestToken: "not-a-guest-token",
};

describe("AuthProvider contract — Cognito (PF reference impl)", () => {
  runAuthProviderContract(cognitoFixtures);
});
