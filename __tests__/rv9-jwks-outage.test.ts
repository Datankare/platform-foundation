/**
 * @jest-environment node
 */
/**
 * __tests__/rv9-jwks-outage.test.ts — Signing keys unavailable is an outage, not a sign-out
 * (review 9 M4, L9, L11)
 *
 * The reviewer's proofs (review9/__tests__/rv9/jwks.test.ts), now asserting the fixed behaviour:
 *   M4  a cold instance whose first JWKS fetch failed refused every token for the whole 30 s
 *       cooldown, and JwksUnavailable bypassed the stale grace (and the remembered verification).
 *       Now: while no keys are held, a short bounded backoff (and a second attempt inside the
 *       call, single flight); and JwksUnavailable reaches the token verifier as "unavailable" — a
 *       fresh remembered verification of that token is honoured, an ordinary route may use the
 *       stale grace, a privileged one fails closed.
 *   L9  a made-up kid spent the refresh cooldown, so a genuinely rotated kid inside it was a 401.
 *       Now a suppressed refresh answers "unavailable" (503 / stale grace), never "invalid".
 *   L11 a request whose GetUser was in flight across a revocation and answered "unavailable"
 *       stood on its pre-revocation entry. Now the stamp is read again on "unavailable" too.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import type { JSONWebKeySet } from "jose";
import { InMemoryCacheProvider } from "@/platform/cache/memory-cache";
import type { CacheProvider } from "@/platform/cache/types";
import {
  JwksKeyStore,
  JwksUnavailableError,
  verifyAccessTokenSignature,
} from "@/platform/auth/jwt-verification";
import {
  TokenVerificationUnavailableError,
  TokenVerifier,
  revokeTokenVerification,
  type ProviderOutcome,
} from "@/platform/auth/token-verification";
import { CognitoAuthProvider } from "@/platform/auth/cognito-provider";
import type { TokenPayload } from "@/platform/auth/types";
import { TEST_JWKS, signJwt } from "@/__tests__/helpers/test-jwt";

const ISS = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x";
const tok = (kid?: string, over: Record<string, unknown> = {}) =>
  signJwt(
    {
      iss: ISS,
      token_use: "access",
      client_id: "c",
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: "u",
      username: "u",
      ...over,
    },
    kid ? { kid } : {}
  );
const check = (token: string, keys: JwksKeyStore) =>
  verifyAccessTokenSignature(token, { issuer: ISS, clientId: "c", keys });
const noSleep = async () => undefined;

describe("M4: a cold instance's first fetch failing", () => {
  it("the reviewer's case: one blip, then JWKS is back — tokens verify without waiting 30 s", async () => {
    let t = 1_000_000;
    let calls = 0;
    const store = new JwksKeyStore(
      async () => {
        calls++;
        if (calls === 1) throw new Error("blip");
        return TEST_JWKS;
      },
      { now: () => t, sleep: async (ms) => void (t += ms) }
    );
    // The call that met the blip retries once (after a short backoff) and succeeds.
    expect((await check(tok(), store)).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("still down for both attempts: unavailable — and retried after a short backoff, not the cooldown", async () => {
    let t = 1_000_000;
    let up = false;
    let calls = 0;
    const store = new JwksKeyStore(
      async () => {
        calls++;
        if (!up) throw new Error("down");
        return TEST_JWKS;
      },
      { now: () => t, sleep: async (ms) => void (t += ms) }
    );
    await expect(check(tok(), store)).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(calls).toBe(2); // bounded: two attempts in one call
    up = true;
    t += 1_000; // well inside the 30 s cooldown
    expect((await check(tok(), store)).ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("the cold backoff is bounded: doubling, never past the cooldown, one fetch at a time", async () => {
    let t = 0;
    let calls = 0;
    const store = new JwksKeyStore(
      async () => {
        calls++;
        throw new Error("down");
      },
      { now: () => t, sleep: noSleep, coldAttempts: 1 }
    );
    // Many concurrent callers on a cold instance: one fetch (single flight).
    await Promise.allSettled([1, 2, 3, 4, 5].map(() => store.current()));
    expect(calls).toBe(1);
    // Within the first backoff (250 ms): no fetch.
    t = 100;
    await expect(store.current()).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(calls).toBe(1);
    // After failures the delay grows, capped at the 30 s cooldown.
    for (let i = 0; i < 12; i++) {
      t += 30_000;
      await store.current().catch(() => undefined);
    }
    const before = calls;
    t += 29_000;
    await store.current().catch(() => undefined);
    expect(calls).toBe(before); // capped at the cooldown: not before 30 s
  });
});

describe("L9: a refresh suppressed by the cooldown", () => {
  it("the reviewer's case: a made-up kid spends the cooldown; a real rotated kid inside it is unavailable, not 401", async () => {
    let t = 1_000_000;
    let phase = 0;
    const rotated: JSONWebKeySet = {
      keys: [{ ...TEST_JWKS.keys[0], kid: "new" }, ...TEST_JWKS.keys],
    };
    const store = new JwksKeyStore(async () => (phase === 0 ? TEST_JWKS : rotated), {
      now: () => t,
    });
    await store.current();
    t += 31_000;
    expect(await check(tok("bogus"), store)).toEqual({
      ok: false,
      reason: "unknown signing key",
    });
    phase = 1;
    t += 1_000; // Cognito starts signing with "new"
    await expect(check(tok("new"), store)).rejects.toBeInstanceOf(JwksUnavailableError);
    // Once the cooldown has passed, the rotation is seen and the token verifies.
    t += 30_000;
    expect((await check(tok("new"), store)).ok).toBe(true);
  });
});

describe("M4/L9 through the provider: unavailable keys fall through to the token verifier", () => {
  const T0 = Date.now();
  let clock = T0;
  let shared: CacheProvider;
  let space = 0;
  const settings = { freshSeconds: 30, graceSeconds: 300 };
  const getUser = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    clock = T0;
    shared = new InMemoryCacheProvider({ namespace: `rv9-jwks-${++space}` });
    getUser.mockReset();
    getUser.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        Username: "u",
        UserAttributes: [{ Name: "email", Value: "u@x.y" }],
      }),
    }));
    global.fetch = getUser as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  /** A provider whose key store starts with the pool's keys and then cannot refresh. */
  function provider(): {
    p: CognitoAuthProvider;
    keys: JwksKeyStore;
    advance: (ms: number) => void;
  } {
    let up = true;
    let keyClock = 0;
    const keys = new JwksKeyStore(
      async () => {
        if (!up) throw new Error("JWKS down");
        return TEST_JWKS;
      },
      { now: () => keyClock, sleep: noSleep, staleMs: 1_000 }
    );
    const p = new CognitoAuthProvider(
      { region: "us-east-1", userPoolId: "us-east-1_x", clientId: "c", timeoutMs: 1000 },
      new TokenVerifier({
        cache: () => shared,
        settings: async () => settings,
        now: () => clock,
      })
    );
    (p as unknown as { keys: JwksKeyStore }).keys = keys;
    return {
      p,
      keys,
      advance: (ms) => {
        up = false;
        keyClock += ms;
      },
    };
  }

  it("a fresh remembered verification of the token is honoured — no GetUser", async () => {
    const { p, keys, advance } = provider();
    const token = tok();
    await keys.current();
    expect(await p.verifyToken(token)).toMatchObject({ sub: "u" });
    expect(getUser).toHaveBeenCalledTimes(1);
    advance(5_000_000); // keys now unobtainable (past the stale window)
    expect(await p.verifyToken(token)).toMatchObject({ sub: "u" });
    expect(await p.verifyToken(token, { privileged: true })).toMatchObject({ sub: "u" });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("past the fresh window: the stale grace on an ordinary route; 503 on a privileged one", async () => {
    const { p, keys, advance } = provider();
    const token = tok();
    await keys.current();
    await p.verifyToken(token);
    advance(5_000_000);
    clock = T0 + 60_000; // past fresh (30 s), inside the grace (300 s)
    expect(await p.verifyToken(token)).toMatchObject({ sub: "u" });
    await expect(p.verifyToken(token, { privileged: true })).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("no remembered verification: unavailable (503), never a 401 — and no GetUser call", async () => {
    const { p, advance } = provider();
    advance(5_000_000);
    await expect(p.verifyToken(tok())).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );
    expect(getUser).not.toHaveBeenCalled();
  });

  it("a revocation voids the stand-in even while the keys are unavailable", async () => {
    const { p, keys, advance } = provider();
    const token = tok();
    await keys.current();
    await p.verifyToken(token);
    await revokeTokenVerification("u", shared);
    advance(5_000_000);
    await expect(p.verifyToken(token)).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );
  });
});

describe("L11: an 'unavailable' answer after a revocation during the call", () => {
  const T0 = 1_800_000_000_000;
  const payload = {
    sub: "user-1",
    email: "u@x.y",
    emailVerified: true,
    iat: 0,
    exp: T0 / 1000 + 3600,
    mfaEnabled: true,
  } as TokenPayload;
  const claims = { exp: T0 / 1000 + 3600, subject: "user-1" };

  it("does not stand on the entry read before the revocation", async () => {
    let clock = T0;
    const shared = new InMemoryCacheProvider({ namespace: "rv9-l11" });
    const v = new TokenVerifier({
      cache: () => shared,
      settings: async () => ({ freshSeconds: 30, graceSeconds: 300 }),
      now: () => clock,
    });
    await v.verify("tk", claims, async () => ({ kind: "valid", payload }));
    clock += 60_000; // past fresh, inside grace
    const ask = jest.fn(async (): Promise<ProviderOutcome> => {
      // Revoked while GetUser is in flight; then GetUser cannot answer.
      await revokeTokenVerification("user-1", shared);
      return { kind: "unavailable", reason: "TooManyRequestsException" };
    });
    await expect(v.verify("tk", claims, ask)).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );
  });

  it("without a revocation the same outage stands on the entry (the grace)", async () => {
    let clock = T0;
    const shared = new InMemoryCacheProvider({ namespace: "rv9-l11b" });
    const v = new TokenVerifier({
      cache: () => shared,
      settings: async () => ({ freshSeconds: 30, graceSeconds: 300 }),
      now: () => clock,
    });
    await v.verify("tk", claims, async () => ({ kind: "valid", payload }));
    clock += 60_000;
    expect(
      await v.verify("tk", claims, async () => ({ kind: "unavailable", reason: "x" }))
    ).toEqual(payload);
  });

  it("a stamp that cannot be read after the outage is no proof: no stand-in", async () => {
    let clock = T0;
    const shared = new InMemoryCacheProvider({ namespace: "rv9-l11c" });
    let failStamp = false;
    const flaky: CacheProvider = new Proxy(shared, {
      get(target, prop, receiver) {
        if (prop === "get")
          return async (key: string) => {
            if (failStamp && key.startsWith("auth:token-revoked:"))
              throw new Error("down");
            return target.get(key);
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const v = new TokenVerifier({
      cache: () => flaky,
      settings: async () => ({ freshSeconds: 30, graceSeconds: 300 }),
      now: () => clock,
    });
    await v.verify("tk", claims, async () => ({ kind: "valid", payload }));
    clock += 60_000;
    await expect(
      v.verify("tk", claims, async () => {
        failStamp = true;
        return { kind: "unavailable", reason: "x" };
      })
    ).rejects.toBeInstanceOf(TokenVerificationUnavailableError);
  });
});
