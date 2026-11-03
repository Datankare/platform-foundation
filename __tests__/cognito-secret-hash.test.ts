/**
 * TASK-197 (audit D-4): a refused client secret is the platform's failure, not the user's.
 *
 * With COGNITO_CLIENT_SECRET wrong or rotated, every call carrying a SECRET_HASH fails with
 * NotAuthorizedException — which was read as `auth.invalid_credentials`, so every user was told
 * "wrong email or password" (and, on sign-up, "sign-ups are closed") while nothing alerted. Now it
 * answers the coded `service.unavailable` (service "auth") and raises an alert; a real wrong
 * password stays `auth.invalid_credentials`.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("@/platform/observability/alert", () => ({ raiseAlert: jest.fn() }));

import { raiseAlert } from "@/platform/observability/alert";
import { resetExternalAlerts } from "@/platform/observability/external-failure";
import {
  CognitoAuthProvider,
  CognitoError,
  isClientSecretRejection,
} from "@/platform/auth/cognito-provider";
import { TEST_JWKS } from "./helpers/test-jwt";

const provider = () =>
  new CognitoAuthProvider({
    region: "us-east-1",
    userPoolId: "us-east-1_TestPool",
    clientId: "test-client-id",
    clientSecret: "rotated-elsewhere",
    timeoutMs: 5000,
    jwks: TEST_JWKS,
  });

const originalFetch = global.fetch;
const refused = (message: string) => ({
  ok: false,
  status: 400,
  json: async () => ({ __type: "NotAuthorizedException", message }),
});

beforeEach(() => {
  (raiseAlert as jest.Mock).mockReset();
  resetExternalAlerts();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("Cognito: a refused client secret (TASK-197, audit D-4)", () => {
  it.each([
    "Unable to verify secret hash for client test-client-id",
    "Client test-client-id is configured for secret but secret was not received",
  ])("sign-in: '%s' → service.unavailable and an alert", async (message) => {
    global.fetch = jest.fn().mockResolvedValue(refused(message)) as typeof fetch;
    const r = (await provider().signIn("a@example.com", "pw")) as unknown as {
      errorCode: string;
      errorParams?: Record<string, string>;
    };
    expect(r.errorCode).toBe("service.unavailable");
    expect(r.errorParams).toEqual({ service: "auth" });
    expect(raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "external.credential" })
    );
  });

  it("sign-up: a refused secret is not read as 'sign-ups are closed'", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        refused("Unable to verify secret hash for client test-client-id")
      ) as typeof fetch;
    const r = (await provider().signUp("a@example.com", "Passw0rd!x")) as unknown as {
      errorCode: string;
    };
    expect(r.errorCode).toBe("service.unavailable");
  });

  it("a wrong password stays auth.invalid_credentials, with no alert", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(refused("Incorrect username or password.")) as typeof fetch;
    const r = (await provider().signIn("a@example.com", "pw")) as unknown as {
      errorCode: string;
    };
    expect(r.errorCode).toBe("auth.invalid_credentials");
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it("SSO: the token endpoint's invalid_client (the client secret) is service.unavailable and alerted", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })
      ) as typeof fetch;
    const p = new CognitoAuthProvider({
      region: "us-east-1",
      userPoolId: "us-east-1_TestPool",
      clientId: "test-client-id",
      clientSecret: "rotated-elsewhere",
      hostedUiDomain: "auth.example.com",
      timeoutMs: 5000,
      jwks: TEST_JWKS,
    });
    const r = await p.handleSsoCallback("google", "code-1", "https://x/cb");
    expect(r).toMatchObject({ success: false, errorCode: "service.unavailable" });
    expect(raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "external.credential" })
    );
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      ) as typeof fetch;
    expect(await p.handleSsoCallback("google", "used", "https://x/cb")).toMatchObject({
      errorCode: "auth.sso_failed",
    });
    // A refused code is the user's: recorded as `rejected` (round 1, L-6), never alerted.
    expect(raiseAlert).toHaveBeenCalledTimes(1);
  });

  // The rebase onto TASK-194: its step-up tells a federated account whose password sign-in is
  // refused that the proof is unavailable — never when the refusal is the client secret.
  it("step-up: a federated account's refused client secret is service.unavailable, not step_up_unavailable", async () => {
    const getUser = {
      ok: true,
      status: 200,
      json: async () => ({
        Username: "Google_1234567890",
        UserAttributes: [
          { Name: "sub", Value: "11111111-2222-4333-8444-555555555555" },
          {
            Name: "identities",
            Value: JSON.stringify([{ providerName: "Google", providerType: "Google" }]),
          },
        ],
        UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
      }),
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(getUser)
      .mockResolvedValueOnce(
        refused("Unable to verify secret hash for client test-client-id")
      ) as typeof fetch;
    const r = await provider().confirmCurrentFactor("tok", "pw", "123456");
    expect(r).toMatchObject({
      success: false,
      errorCode: "service.unavailable",
      errorParams: { service: "auth" },
    });
    expect(raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "external.credential" })
    );
    // A federated account's own refused password sign-in is still told the proof is unavailable.
    (raiseAlert as jest.Mock).mockReset();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(getUser)
      .mockResolvedValueOnce(refused("Incorrect username or password.")) as typeof fetch;
    expect(await provider().confirmCurrentFactor("tok", "pw", "123456")).toMatchObject({
      errorCode: "auth.step_up_unavailable",
    });
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it("recognises the rejection by type and message only", () => {
    expect(
      isClientSecretRejection(
        new CognitoError(
          "Unable to verify secret hash for client x",
          "NotAuthorizedException",
          400
        )
      )
    ).toBe(true);
    expect(
      isClientSecretRejection(
        new CognitoError(
          "Unable to verify secret hash for client x",
          "InvalidParameterException",
          400
        )
      )
    ).toBe(false);
    // Review round 1 (nit): the API's other wording, one word.
    expect(
      isClientSecretRejection(
        new CognitoError(
          "SecretHash does not match for the client: x",
          "NotAuthorizedException",
          400
        )
      )
    ).toBe(true);
    expect(isClientSecretRejection("secret hash")).toBe(false);
  });
});
