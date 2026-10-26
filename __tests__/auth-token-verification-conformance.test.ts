/**
 * @jest-environment node
 */
/**
 * __tests__/auth-token-verification-conformance.test.ts — the platform's CognitoAuthProvider
 * holds the access-token verification contract (TASK-171; reviews 8 M5, 9 M4/L9/L11)
 *
 * The cases are the kit's (__tests__/contract/auth-token-verification-contract.ts), formerly
 * __tests__/jwt-verification.test.ts and __tests__/rv9-jwks-outage.test.ts, which drove this
 * class directly. An app with its own AuthProvider runs the same kit against it in its own runner
 * (MIGRATION_v5_to_v6 §1b) — this file is the platform's runner and drives the platform's class.
 *
 * The adapter: the kit's key store is the provider's signing-key store, and GetUser — which this
 * provider makes over fetch — is answered from the kit's lookup in Cognito's JSON form. Below the
 * kit, the cases about the platform's pool helpers (the JWKS address, one store per pool).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { CognitoAuthProvider } from "@/platform/auth/cognito-provider";
import {
  jwksUrl,
  poolKeyStore,
  staticKeyStore,
  type JwksKeyStore,
} from "@/platform/auth/jwt-verification";
import { TokenVerificationUnavailableError } from "@/platform/auth/token-verification";
import {
  runAuthTokenVerificationContract,
  type UserLookupAnswer,
} from "./contract/auth-token-verification-contract";
import { TEST_JWKS, signJwt } from "./helpers/test-jwt";

const originalFetch = global.fetch;

/** Cognito's answer to GetUser, as fetch returns it, for the kit's lookup answer. */
function cognitoReply(answer: UserLookupAnswer) {
  const reply = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  if (answer.kind === "user")
    return reply(200, {
      Username: answer.username,
      UserAttributes: [
        { Name: "email", Value: answer.email },
        ...(answer.sub ? [{ Name: "sub", Value: answer.sub }] : []),
      ],
    });
  if (answer.kind === "unavailable")
    return reply(400, { __type: "TooManyRequestsException", message: answer.reason });
  return reply(400, { __type: "NotAuthorizedException", message: "Invalid token" });
}

runAuthTokenVerificationContract("CognitoAuthProvider (platform)", {
  makeProvider: ({ pool, keys, tokens, lookup }) => {
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["X-Amz-Target"] !== "AWSCognitoIdentityProviderService.GetUser")
        throw new Error(`unexpected Cognito call: ${headers["X-Amz-Target"]}`);
      const { AccessToken } = JSON.parse(String(init?.body ?? "{}")) as {
        AccessToken: string;
      };
      return cognitoReply(await lookup(AccessToken));
    }) as unknown as typeof fetch;
    const provider = new CognitoAuthProvider({ ...pool, timeoutMs: 5000 }, tokens);
    // The provider's signing-key store is chosen from its config (the pool's, or pinned keys);
    // the kit gives it the store the case controls.
    (provider as unknown as { keys: JwksKeyStore }).keys = keys;
    return provider;
  },
  cleanup: () => {
    global.fetch = originalFetch;
  },
});

describe("the platform's pool key helpers", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("are fetched from the pool's JWKS address, one store per pool", async () => {
    expect(jwksUrl("eu-west-1", "eu-west-1_Abc")).toBe(
      "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Abc/.well-known/jwks.json"
    );
    expect(poolKeyStore("eu-west-1", "eu-west-1_Abc")).toBe(
      poolKeyStore("eu-west-1", "eu-west-1_Abc")
    );
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => TEST_JWKS,
    })) as unknown as typeof fetch;
    const keys = poolKeyStore("eu-west-2", "eu-west-2_Fetch");
    expect(await keys.current()).toEqual(TEST_JWKS);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
      jwksUrl("eu-west-2", "eu-west-2_Fetch")
    );
    expect((await staticKeyStore(TEST_JWKS).current()).keys).toHaveLength(1);
  });

  it("a provider configured without keys fetches its pool's; unreachable, it is unavailable (503)", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const provider = new CognitoAuthProvider({
      region: "us-east-1",
      userPoolId: "us-east-1_Unreachable",
      clientId: "test-client-id",
      timeoutMs: 5000,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({
      sub: "user-123",
      username: "user-123",
      token_use: "access",
      client_id: "test-client-id",
      iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Unreachable",
      iat: now - 10,
      exp: now + 3600,
    });
    await expect(provider.verifyToken(token)).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );
  });

  it("a provider configured with pinned keys verifies with them", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        Username: "user-123",
        UserAttributes: [{ Name: "sub", Value: "user-123" }],
      }),
    })) as unknown as typeof fetch;
    const provider = new CognitoAuthProvider({
      region: "us-east-1",
      userPoolId: "us-east-1_TestPool",
      clientId: "test-client-id",
      timeoutMs: 5000,
      jwks: TEST_JWKS,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({
      sub: "user-123",
      username: "user-123",
      token_use: "access",
      client_id: "test-client-id",
      iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool",
      iat: now - 10,
      exp: now + 3600,
      jti: "pinned-1",
    });
    expect(await provider.verifyToken(token)).toMatchObject({ sub: "user-123" });
  });
});
