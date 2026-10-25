/**
 * @jest-environment node
 */
/**
 * __tests__/jwt-verification.test.ts — every access token's signature is checked locally before
 * GetUser (review 8 M5; platform/auth/jwt-verification.ts)
 *
 * foreignTokenReason checked claims only, so a forged unsigned token with the right claims cost a
 * GetUser call — a flood of them drained the per-account quota into an outage (and the stale
 * grace). Now: RS256 only, the key chosen by kid from the pool's JWKS (kept, single flight,
 * refreshed at most once per cooldown on an unknown kid, refused after it), iss/exp/nbf/token_use/
 * client_id checked. Hostile tokens of every kind are refused and none reaches GetUser.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { createHmac, generateKeyPairSync } from "node:crypto";
import type { JSONWebKeySet } from "jose";
import { getCache } from "@/platform/cache";
import {
  CognitoAuthProvider,
  type CognitoConfig,
} from "@/platform/auth/cognito-provider";
import {
  JwksKeyStore,
  JwksUnavailableError,
  jwksUrl,
  poolKeyStore,
  staticKeyStore,
  verifyAccessTokenSignature,
} from "@/platform/auth/jwt-verification";
import { TokenVerificationUnavailableError } from "@/platform/auth/token-verification";
import {
  OTHER_KEY_PAIR,
  TEST_JWKS,
  TEST_KID,
  TEST_PUBLIC_KEY,
  signJwt,
} from "./helpers/test-jwt";

const CONFIG: CognitoConfig = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
  timeoutMs: 5000,
  jwks: TEST_JWKS,
};
const ISS = `https://cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}`;
const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  sub: "user-123",
  username: "user-123",
  token_use: "access",
  client_id: CONFIG.clientId,
  iss: ISS,
  iat: now() - 10,
  exp: now() + 3600,
  ...over,
});
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

const originalFetch = global.fetch;
let mockFetch: jest.Mock;
beforeEach(async () => {
  await getCache().clear();
  mockFetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      Username: "user-123",
      UserAttributes: [{ Name: "email", Value: "u@x.y" }],
    }),
  }));
  global.fetch = mockFetch as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

/** Every hostile token: refused, and no call reaches Cognito. */
const HOSTILE: [string, () => string][] = [
  [
    "unsigned, alg none",
    () => `${b64({ alg: "none", kid: TEST_KID })}.${b64(claims())}.`,
  ],
  [
    "HS256 signed with the pool's public key as the secret",
    () => {
      const input = `${b64({ alg: "HS256", kid: TEST_KID })}.${b64(claims())}`;
      const secret = TEST_PUBLIC_KEY.export({ format: "pem", type: "spki" });
      return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
    },
  ],
  ["RS256 with a forged signature", () => `${signJwt(claims()).slice(0, -8)}AAAAAAAA`],
  [
    "signed by another key, with the pool's kid",
    () => signJwt(claims(), {}, OTHER_KEY_PAIR.privateKey),
  ],
  ["a kid the pool does not have", () => signJwt(claims(), { kid: "made-up" })],
  ["no kid", () => signJwt(claims(), { kid: undefined })],
  ["RS512", () => signJwt(claims(), { alg: "RS512" })],
  ["expired", () => signJwt(claims({ exp: now() - 5 }))],
  ["not yet valid (nbf)", () => signJwt(claims({ nbf: now() + 600 }))],
  ["another pool's issuer", () => signJwt(claims({ iss: `${ISS}x` }))],
  ["another app client", () => signJwt(claims({ client_id: "other-client" }))],
  ["an ID token", () => signJwt(claims({ token_use: "id" }))],
  ["no exp", () => signJwt(claims({ exp: undefined }))],
  ["undecodable", () => "not.a.jwt"],
];

describe("hostile tokens never reach GetUser (M5)", () => {
  it.each(HOSTILE)("%s: refused locally", async (_name, make) => {
    const provider = new CognitoAuthProvider(CONFIG);
    expect(await provider.verifyToken(make())).toBeNull();
    expect(await provider.verifyToken(make(), { privileged: true })).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a genuine token is verified by GetUser after its signature", async () => {
    const provider = new CognitoAuthProvider(CONFIG);
    expect(await provider.verifyToken(signJwt(claims()))).toMatchObject({
      sub: "user-123",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a flood of forged tokens costs no GetUser call", async () => {
    const provider = new CognitoAuthProvider(CONFIG);
    for (let i = 0; i < 50; i++)
      await provider.verifyToken(
        signJwt(claims({ jti: `f${i}` }), {}, OTHER_KEY_PAIR.privateKey)
      );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("the pool's keys", () => {
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ROTATED_JWKS: JSONWebKeySet = {
    keys: [
      ...TEST_JWKS.keys,
      {
        ...(rotated.publicKey.export({ format: "jwk" }) as Record<string, string>),
        kid: "rotated-key",
        alg: "RS256",
      },
    ],
  };

  function store(fetcher: jest.Mock, t = { ms: 0 }) {
    return new JwksKeyStore(fetcher, {
      now: () => t.ms,
      cooldownMs: 30_000,
      maxAgeMs: 3_600_000,
      staleMs: 86_400_000,
    });
  }
  const check = (token: string, keys: JwksKeyStore) =>
    verifyAccessTokenSignature(token, { issuer: ISS, clientId: CONFIG.clientId, keys });

  it("are fetched once for concurrent requests (single flight), and kept", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = jest.fn(async () => {
      await gate;
      return TEST_JWKS;
    });
    const keys = store(fetcher);
    const all = Promise.all([1, 2, 3, 4].map(() => check(signJwt(claims()), keys)));
    release();
    expect((await all).every((r) => r.ok)).toBe(true);
    await check(signJwt(claims()), keys);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a rotation: an unknown kid refreshes once and the new key verifies", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(TEST_JWKS)
      .mockResolvedValueOnce(ROTATED_JWKS);
    const t = { ms: 0 };
    const keys = store(fetcher, t);
    await check(signJwt(claims()), keys);
    t.ms = 60_000;
    const token = signJwt(claims(), { kid: "rotated-key" }, rotated.privateKey);
    expect((await check(token, keys)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("made-up kids: one refresh per cooldown at most; refused after it, unavailable within it", async () => {
    const fetcher = jest.fn(async () => TEST_JWKS);
    const t = { ms: 0 };
    const keys = store(fetcher, t);
    await check(signJwt(claims()), keys);
    t.ms = 60_000;
    // The first refreshes the keys, and is refused: they do not hold it.
    expect(await check(signJwt(claims(), { kid: "bogus-0" }), keys)).toEqual({
      ok: false,
      reason: "unknown signing key",
    });
    // Within the cooldown no refresh is made: such a kid might be a genuine rotation, so the
    // answer is "unavailable" (503 / stale grace), never a 401 (review 9 L9).
    for (let i = 1; i < 20; i++) {
      await expect(
        check(signJwt(claims(), { kid: `bogus-${i}` }), keys)
      ).rejects.toBeInstanceOf(JwksUnavailableError);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("a failed refresh keeps the keys fetched before (up to a day), then is unavailable", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(TEST_JWKS)
      .mockRejectedValue(new Error("JWKS down"));
    const t = { ms: 0 };
    const keys = store(fetcher, t);
    await check(signJwt(claims()), keys);
    t.ms = 2 * 3_600_000; // past maxAge: refresh fails, old keys stand in
    expect((await check(signJwt(claims()), keys)).ok).toBe(true);
    t.ms = 90_000_000; // past a day
    await expect(check(signJwt(claims()), keys)).rejects.toBeInstanceOf(
      JwksUnavailableError
    );
  });

  it("keys that cannot be fetched at all: verification is unavailable (503), never a 401", async () => {
    const keys = store(jest.fn(async () => Promise.reject(new Error("down"))));
    await expect(check(signJwt(claims()), keys)).rejects.toBeInstanceOf(
      JwksUnavailableError
    );
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const provider = new CognitoAuthProvider({
      ...CONFIG,
      jwks: undefined,
      userPoolId: "us-east-1_Unreachable",
    });
    const token = signJwt(
      claims({ iss: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Unreachable` })
    );
    await expect(provider.verifyToken(token)).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );
  });

  it("an answer that is not a JWKS is not kept", async () => {
    const keys = store(jest.fn(async () => ({ nope: true }) as unknown as JSONWebKeySet));
    await expect(check(signJwt(claims()), keys)).rejects.toBeInstanceOf(
      JwksUnavailableError
    );
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
});
