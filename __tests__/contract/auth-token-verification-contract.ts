/**
 * __tests__/contract/auth-token-verification-contract.ts
 * Access-token verification conformance kit (TASK-171; reviews 8 M5, 9 M4/L9/L11). Not a
 * *.test.ts.
 *
 * What every AuthProvider's verifyToken owes, whatever it is built on — the platform's fetch-based
 * CognitoAuthProvider, or a consumer's own (Playform's is on the AWS SDK). The cases were PF's
 * __tests__/jwt-verification.test.ts and __tests__/rv9-jwks-outage.test.ts, which drove PF's
 * provider class, so an app with its own provider could only copy them. Now the kit drives a
 * provider the caller builds:
 *
 *   M5   every hostile token (forged, unsigned / alg none, HS256 over the public key, another
 *        key, an unknown or missing kid, RS512, expired, not yet valid, another pool's issuer,
 *        another app client, an ID token, no exp, undecodable) is refused locally — on ordinary
 *        and privileged routes — and never reaches the identity provider's user lookup; a genuine
 *        one is looked up once, after its signature; a flood of forged ones costs no lookup
 *   keys the signing keys are fetched once for concurrent requests and kept; a rotation refreshes
 *        once; made-up kids refresh at most once per cooldown (refused after it, unavailable within
 *        it); a failed refresh keeps the keys fetched before for a day, then is unavailable; keys
 *        never fetched, or an answer that is not a JWKS, are unavailable — never "invalid"
 *   M4   a cold instance's failed first fetch is retried within the call after a short backoff,
 *        then on a short doubling backoff capped at the cooldown, one fetch at a time
 *   L9   a refresh suppressed by the cooldown answers unavailable for a genuinely rotated kid
 *   M4   unavailable keys reach the token verifier as "unavailable": a fresh remembered
 *        verification of that token is honoured; past it the stale grace on an ordinary route and
 *        503 on a privileged one (fail closed); with none remembered, 503 and no lookup; a
 *        revocation voids the stand-in
 *   L11  an "unavailable" lookup after a revocation during the call never stands on the entry
 *        read before it; without a revocation the grace stands; an unreadable stamp is no proof
 *   177  the subject is the token's `sub` (TASK-177) — for a federated user too, whose username
 *        (`Google_…`) differs: payload.sub is the sub, never the username, and a revocation by
 *        the sub voids that user's remembered verification; one by the username voids nothing;
 *        a lookup answering for another sub, or with no sub at all, is refused (review 17 M2/L1)
 *
 * How to run it — a factory for the provider under test, given what the kit controls:
 *
 *   runAuthTokenVerificationContract("Acme provider", {
 *     makeProvider: ({ pool, keys, tokens, lookup }) =>
 *       new AcmeAuthProvider({ ...pool, keyStore: keys, tokenVerifier: tokens,
 *                              getUser: (token) => lookupToAcme(lookup, token) }),
 *   });
 *
 *   pool    the pool and app client the provider is configured for (tokens' iss and client_id)
 *   keys    the signing-key store it must check every signature with: built by `makeKeyStore`
 *           (default: platform/auth/jwt-verification's JwksKeyStore) over the kit's JWKS fake
 *   tokens  the TokenVerifier (platform/auth/token-verification) it must remember verifications in
 *   lookup  the identity provider's user lookup (Cognito GetUser), answered by the kit: route the
 *           provider's call to it — `user` (the token is good), `unavailable` (throttled, down)
 *           or `invalid` (the identity provider refused it). Map each to your SDK's or HTTP
 *           client's own answer (PF's runner answers its fetch; Playform's its SDK client)
 *
 * A consumer that uses the platform's JwksKeyStore and verifyAccessTokenSignature passes neither
 * `makeKeyStore` nor `verifySignature`; one with its own passes them, honouring KeyStoreOptions
 * (cooldownMs, maxAgeMs, staleMs, coldAttempts, now, sleep, pinned).
 */

import type { JSONWebKeySet } from "jose";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { InMemoryCacheProvider } from "@/platform/cache/memory-cache";
import type { CacheProvider } from "@/platform/cache/types";
import {
  JwksKeyStore,
  JwksUnavailableError,
  verifyAccessTokenSignature,
  type KeyStoreOptions,
} from "@/platform/auth/jwt-verification";
import {
  TokenVerificationUnavailableError,
  TokenVerifier,
  revokeTokenVerification,
} from "@/platform/auth/token-verification";
import type { TokenPayload } from "@/platform/auth/types";
import {
  OTHER_KEY_PAIR,
  TEST_JWKS,
  TEST_KID,
  TEST_PUBLIC_KEY,
  signJwt,
} from "../helpers/test-jwt";

/** What the kit's user lookup answers for a token (the provider's GetUser, or its equivalent). */
export type UserLookupAnswer =
  | {
      readonly kind: "user";
      readonly username: string;
      readonly email: string;
      /**
       * The pool's `sub` attribute of the user (GetUser lists it): the token's own sub. An answer
       * without one must be refused (review 17 L1).
       */
      readonly sub?: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "invalid" };

/** The provider under test: only verifyToken is driven. */
export interface TokenVerifyingProvider {
  verifyToken(
    token: string,
    options?: { readonly privileged?: boolean }
  ): Promise<TokenPayload | null>;
}

export interface ProviderFactoryArgs {
  /** The pool and app client the provider is configured for. */
  readonly pool: {
    readonly region: string;
    readonly userPoolId: string;
    readonly clientId: string;
  };
  /** https://cognito-idp.<region>.amazonaws.com/<pool> — the tokens' iss. */
  readonly issuer: string;
  /** The signing keys every token's signature must be checked with. */
  readonly keys: JwksKeyStore;
  /** Where the provider remembers verifications (fresh window, stale grace, revocations). */
  readonly tokens: TokenVerifier;
  /** The identity provider's user lookup, answered by the kit. */
  readonly lookup: (accessToken: string) => Promise<UserLookupAnswer>;
}

export interface AuthTokenVerificationSubject {
  readonly makeProvider: (args: ProviderFactoryArgs) => TokenVerifyingProvider;
  /** The key store over a JWKS fetcher (default: the platform's JwksKeyStore). */
  readonly makeKeyStore?: (
    fetchKeys: () => Promise<JSONWebKeySet>,
    options: KeyStoreOptions
  ) => JwksKeyStore;
  /** The signature check (default: the platform's verifyAccessTokenSignature). */
  readonly verifySignature?: typeof verifyAccessTokenSignature;
  /** Undo whatever makeProvider installed (a global fetch, an SDK stub), after each case. */
  readonly cleanup?: () => void;
}

const POOL = {
  region: "us-east-1",
  userPoolId: "us-east-1_TestPool",
  clientId: "test-client-id",
} as const;
const ISS = `https://cognito-idp.${POOL.region}.amazonaws.com/${POOL.userPoolId}`;
const SETTINGS = { freshSeconds: 30, graceSeconds: 300 };
const noSleep = async () => undefined;
const nowS = () => Math.floor(Date.now() / 1000);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** An access token's claims, as the pool issues them for the app client. */
export const accessClaims = (over: Record<string, unknown> = {}) => ({
  sub: "user-123",
  username: "user-123",
  token_use: "access",
  client_id: POOL.clientId,
  iss: ISS,
  iat: nowS() - 10,
  exp: nowS() + 3600,
  ...over,
});

/** Every hostile token: refused locally, on every route, and never looked up (review 8 M5). */
export const HOSTILE_TOKENS: readonly [string, () => string][] = [
  [
    "unsigned, alg none",
    () => `${b64({ alg: "none", kid: TEST_KID })}.${b64(accessClaims())}.`,
  ],
  [
    "HS256 signed with the pool's public key as the secret",
    () => {
      const input = `${b64({ alg: "HS256", kid: TEST_KID })}.${b64(accessClaims())}`;
      const secret = TEST_PUBLIC_KEY.export({ format: "pem", type: "spki" });
      return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
    },
  ],
  [
    "RS256 with a forged signature",
    () => `${signJwt(accessClaims()).slice(0, -8)}AAAAAAAA`,
  ],
  [
    "signed by another key, with the pool's kid",
    () => signJwt(accessClaims(), {}, OTHER_KEY_PAIR.privateKey),
  ],
  ["a kid the pool does not have", () => signJwt(accessClaims(), { kid: "made-up" })],
  ["no kid", () => signJwt(accessClaims(), { kid: undefined })],
  ["RS512", () => signJwt(accessClaims(), { alg: "RS512" })],
  ["expired", () => signJwt(accessClaims({ exp: nowS() - 5 }))],
  ["not yet valid (nbf)", () => signJwt(accessClaims({ nbf: nowS() + 600 }))],
  ["another pool's issuer", () => signJwt(accessClaims({ iss: `${ISS}x` }))],
  ["another app client", () => signJwt(accessClaims({ client_id: "other-client" }))],
  ["an ID token", () => signJwt(accessClaims({ token_use: "id" }))],
  ["no exp", () => signJwt(accessClaims({ exp: undefined }))],
  ["undecodable", () => "not.a.jwt"],
];

/** What every section of the kit shares: the subject's pieces and the case's state. */
interface Kit {
  readonly T0: number;
  readonly state: {
    clock: number;
    shared: CacheProvider;
    lookup: jest.Mock<Promise<UserLookupAnswer>, [string]>;
  };
  readonly makeKeyStore: (
    fetchKeys: () => Promise<JSONWebKeySet>,
    options: KeyStoreOptions
  ) => JwksKeyStore;
  readonly check: (
    token: string,
    keys: JwksKeyStore
  ) => ReturnType<typeof verifyAccessTokenSignature>;
  /** A TokenVerifier over the case's shared cache and clock (or `cache`). */
  readonly verifier: (cache?: CacheProvider) => TokenVerifier;
  readonly provider: (
    keys: JwksKeyStore,
    tokens?: TokenVerifier
  ) => TokenVerifyingProvider;
  /** The pool's keys, fixed (a pinned store: an unknown kid is refused at once). */
  readonly pinnedKeys: () => JwksKeyStore;
}

/** The lookup's default answer: the token's own user (its username and its sub). */
function userAnswer(token: string): UserLookupAnswer {
  const [, payload] = token.split(".");
  let username = "user-123";
  let sub: string | undefined;
  try {
    const c = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
      username?: unknown;
      sub?: unknown;
    };
    if (typeof c.username === "string") username = c.username;
    if (typeof c.sub === "string") sub = c.sub;
  } catch {
    // the default
  }
  return { kind: "user", username, email: "u@x.y", ...(sub ? { sub } : {}) };
}

export function runAuthTokenVerificationContract(
  name: string,
  subject: AuthTokenVerificationSubject
): void {
  const makeKeyStore =
    subject.makeKeyStore ??
    ((fetchKeys: () => Promise<JSONWebKeySet>, options: KeyStoreOptions) =>
      new JwksKeyStore(fetchKeys, options));
  const verifySignature = subject.verifySignature ?? verifyAccessTokenSignature;
  let space = 0;
  const T0 = Date.now();
  const state: Kit["state"] = {
    clock: T0,
    shared: new InMemoryCacheProvider({ namespace: "token-contract-0" }),
    lookup: jest.fn(async (token: string) => userAnswer(token)),
  };
  const verifier = (cache?: CacheProvider) =>
    new TokenVerifier({
      cache: () => cache ?? state.shared,
      settings: async () => SETTINGS,
      now: () => state.clock,
    });
  const k: Kit = {
    T0,
    state,
    makeKeyStore,
    check: (token, keys) =>
      verifySignature(token, { issuer: ISS, clientId: POOL.clientId, keys }),
    verifier,
    provider: (keys, tokens = verifier()) =>
      subject.makeProvider({
        pool: POOL,
        issuer: ISS,
        keys,
        tokens,
        lookup: (token) => state.lookup(token),
      }),
    pinnedKeys: () => makeKeyStore(async () => TEST_JWKS, { pinned: true }),
  };

  describe(`${name} — access-token verification conformance`, () => {
    beforeEach(() => {
      state.clock = T0;
      state.shared = new InMemoryCacheProvider({
        namespace: `token-contract-${++space}`,
      });
      state.lookup = jest.fn(async (token: string) => userAnswer(token));
    });
    afterEach(() => subject.cleanup?.());

    hostileTokenCases(k);
    signingKeyCases(k);
    coldStartCases(k);
    suppressedRefreshCases(k);
    unavailableKeyCases(k);
    revocationDuringLookupCases(k);
    subjectCases(k);
  });
}

/** A federated (Google) user as the pool issues its access token: username ≠ sub. */
const FEDERATED = {
  sub: "7d3f0a52-1c9e-4b6a-9f21-5e8c0d4b2a17",
  username: "Google_109320000000000000001",
} as const;

function subjectCases(k: Kit): void {
  describe("the subject is the token's sub, for every user (TASK-177)", () => {
    it("a federated user (username Google_…) is named by its sub, never its username", async () => {
      const p = k.provider(k.pinnedKeys());
      const payload = await p.verifyToken(signJwt(accessClaims(FEDERATED)));
      expect(payload).toMatchObject({ sub: FEDERATED.sub });
      expect(payload!.sub).not.toBe(FEDERATED.username);
      // A native user of a pool that signs in by address: its username is its sub — the same.
      const native = "0b6e7c1d-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
      expect(
        await p.verifyToken(signJwt(accessClaims({ sub: native, username: native })))
      ).toMatchObject({ sub: native });
    });

    it("a revocation by the sub voids a federated user's remembered verification; one by the username voids nothing", async () => {
      const p = k.provider(k.pinnedKeys());
      const token = signJwt(accessClaims({ ...FEDERATED, jti: "fed-1" }));
      await p.verifyToken(token);
      await p.verifyToken(token);
      expect(k.state.lookup).toHaveBeenCalledTimes(1);
      await revokeTokenVerification(FEDERATED.username, k.state.shared);
      await p.verifyToken(token);
      expect(k.state.lookup).toHaveBeenCalledTimes(1);
      await revokeTokenVerification(FEDERATED.sub, k.state.shared);
      expect(await p.verifyToken(token)).toMatchObject({ sub: FEDERATED.sub });
      expect(k.state.lookup).toHaveBeenCalledTimes(2);
    });

    it("a lookup answering for another user than the token's sub is never that token's", async () => {
      const p = k.provider(k.pinnedKeys());
      k.state.lookup = jest.fn(async (_token: string): Promise<UserLookupAnswer> => ({
        kind: "user",
        username: FEDERATED.username,
        email: "u@x.y",
        sub: "00000000-0000-4000-8000-000000000000",
      }));
      // Review 17 M2: refused — never the token's user with another user's attributes.
      expect(await p.verifyToken(signJwt(accessClaims(FEDERATED)))).toBeNull();
      expect(k.state.lookup).toHaveBeenCalledTimes(1);
    });

    it("a lookup answering with no sub is never that token's (review 17 L1)", async () => {
      const p = k.provider(k.pinnedKeys());
      k.state.lookup = jest.fn(async (_token: string): Promise<UserLookupAnswer> => ({
        kind: "user",
        username: FEDERATED.username,
        email: "u@x.y",
      }));
      expect(await p.verifyToken(signJwt(accessClaims(FEDERATED)))).toBeNull();
    });
  });
}

function hostileTokenCases(k: Kit): void {
  describe("hostile tokens never reach the user lookup (review 8 M5)", () => {
    it.each(HOSTILE_TOKENS)("%s: refused locally", async (_label, make) => {
      const p = k.provider(k.pinnedKeys());
      expect(await p.verifyToken(make())).toBeNull();
      expect(await p.verifyToken(make(), { privileged: true })).toBeNull();
      expect(k.state.lookup).not.toHaveBeenCalled();
    });

    it("a genuine token is looked up once, after its signature", async () => {
      const p = k.provider(k.pinnedKeys());
      expect(await p.verifyToken(signJwt(accessClaims()))).toMatchObject({
        sub: "user-123",
      });
      expect(k.state.lookup).toHaveBeenCalledTimes(1);
    });

    it("a flood of forged tokens costs no lookup", async () => {
      const p = k.provider(k.pinnedKeys());
      for (let i = 0; i < 50; i++)
        await p.verifyToken(
          signJwt(accessClaims({ jti: `f${i}` }), {}, OTHER_KEY_PAIR.privateKey)
        );
      expect(k.state.lookup).not.toHaveBeenCalled();
    });

    it("a token the identity provider refuses is not valid", async () => {
      k.state.lookup.mockImplementation(async () => ({ kind: "invalid" }));
      const p = k.provider(k.pinnedKeys());
      expect(await p.verifyToken(signJwt(accessClaims()))).toBeNull();
    });
  });
}

function signingKeyCases(k: Kit): void {
  describe("the pool's signing keys", () => {
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
    const store = (fetcher: () => Promise<JSONWebKeySet>, t = { ms: 0 }) =>
      k.makeKeyStore(fetcher, {
        now: () => t.ms,
        cooldownMs: 30_000,
        maxAgeMs: 3_600_000,
        staleMs: 86_400_000,
      });

    it("are fetched once for concurrent requests (single flight), and kept", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const fetcher = jest.fn(async () => {
        await gate;
        return TEST_JWKS;
      });
      const keys = store(fetcher);
      const all = Promise.all(
        [1, 2, 3, 4].map(() => k.check(signJwt(accessClaims()), keys))
      );
      release();
      expect((await all).every((r) => r.ok)).toBe(true);
      await k.check(signJwt(accessClaims()), keys);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("a rotation: an unknown kid refreshes once and the new key verifies", async () => {
      const fetcher = jest
        .fn<Promise<JSONWebKeySet>, []>()
        .mockResolvedValueOnce(TEST_JWKS)
        .mockResolvedValueOnce(ROTATED_JWKS);
      const t = { ms: 0 };
      const keys = store(fetcher, t);
      await k.check(signJwt(accessClaims()), keys);
      t.ms = 60_000;
      const token = signJwt(accessClaims(), { kid: "rotated-key" }, rotated.privateKey);
      expect((await k.check(token, keys)).ok).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("made-up kids: one refresh per cooldown at most; refused after it, unavailable within it", async () => {
      const fetcher = jest.fn(async () => TEST_JWKS);
      const t = { ms: 0 };
      const keys = store(fetcher, t);
      await k.check(signJwt(accessClaims()), keys);
      t.ms = 60_000;
      expect(await k.check(signJwt(accessClaims(), { kid: "bogus-0" }), keys)).toEqual({
        ok: false,
        reason: "unknown signing key",
      });
      // Within the cooldown no refresh: such a kid might be a genuine rotation — unavailable
      // (503 / stale grace), never a 401 (review 9 L9).
      for (let i = 1; i < 20; i++) {
        await expect(
          k.check(signJwt(accessClaims(), { kid: `bogus-${i}` }), keys)
        ).rejects.toBeInstanceOf(JwksUnavailableError);
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("a failed refresh keeps the keys fetched before (up to a day), then is unavailable", async () => {
      const fetcher = jest
        .fn<Promise<JSONWebKeySet>, []>()
        .mockResolvedValueOnce(TEST_JWKS)
        .mockRejectedValue(new Error("JWKS down"));
      const t = { ms: 0 };
      const keys = store(fetcher, t);
      await k.check(signJwt(accessClaims()), keys);
      t.ms = 2 * 3_600_000; // past maxAge: the refresh fails, the old keys stand in
      expect((await k.check(signJwt(accessClaims()), keys)).ok).toBe(true);
      t.ms = 90_000_000; // past a day
      await expect(k.check(signJwt(accessClaims()), keys)).rejects.toBeInstanceOf(
        JwksUnavailableError
      );
    });

    it("keys that cannot be fetched at all: unavailable (503), never a 401 — through the provider too", async () => {
      const down = () =>
        k.makeKeyStore(async () => Promise.reject(new Error("down")), {
          sleep: noSleep,
        });
      await expect(k.check(signJwt(accessClaims()), down())).rejects.toBeInstanceOf(
        JwksUnavailableError
      );
      await expect(
        k.provider(down()).verifyToken(signJwt(accessClaims()))
      ).rejects.toBeInstanceOf(TokenVerificationUnavailableError);
      expect(k.state.lookup).not.toHaveBeenCalled();
    });

    it("an answer that is not a JWKS is not kept", async () => {
      const keys = k.makeKeyStore(
        async () => ({ nope: true }) as unknown as JSONWebKeySet,
        { sleep: noSleep }
      );
      await expect(k.check(signJwt(accessClaims()), keys)).rejects.toBeInstanceOf(
        JwksUnavailableError
      );
    });
  });
}

function coldStartCases(k: Kit): void {
  describe("a cold instance's first fetch failing (review 9 M4)", () => {
    it("one blip, then the keys are back — tokens verify without waiting for the cooldown", async () => {
      let t = 1_000_000;
      let calls = 0;
      const keys = k.makeKeyStore(
        async () => {
          calls++;
          if (calls === 1) throw new Error("blip");
          return TEST_JWKS;
        },
        { now: () => t, sleep: async (ms) => void (t += ms) }
      );
      expect((await k.check(signJwt(accessClaims()), keys)).ok).toBe(true);
      expect(calls).toBe(2);
    });

    it("still down for both attempts: unavailable — and retried after a short backoff, not the cooldown", async () => {
      let t = 1_000_000;
      let up = false;
      let calls = 0;
      const keys = k.makeKeyStore(
        async () => {
          calls++;
          if (!up) throw new Error("down");
          return TEST_JWKS;
        },
        { now: () => t, sleep: async (ms) => void (t += ms) }
      );
      await expect(k.check(signJwt(accessClaims()), keys)).rejects.toBeInstanceOf(
        JwksUnavailableError
      );
      expect(calls).toBe(2); // bounded: two attempts in one call
      up = true;
      t += 1_000; // well inside the 30 s cooldown
      expect((await k.check(signJwt(accessClaims()), keys)).ok).toBe(true);
      expect(calls).toBe(3);
    });

    it("the cold backoff is bounded: doubling, never past the cooldown, one fetch at a time", async () => {
      let t = 0;
      let calls = 0;
      const keys = k.makeKeyStore(
        async () => {
          calls++;
          throw new Error("down");
        },
        { now: () => t, sleep: noSleep, coldAttempts: 1 }
      );
      await Promise.allSettled([1, 2, 3, 4, 5].map(() => keys.current()));
      expect(calls).toBe(1);
      t = 100; // within the first backoff (250 ms): no fetch
      await expect(keys.current()).rejects.toBeInstanceOf(JwksUnavailableError);
      expect(calls).toBe(1);
      for (let i = 0; i < 12; i++) {
        t += 30_000;
        await keys.current().catch(() => undefined);
      }
      const before = calls;
      t += 29_000;
      await keys.current().catch(() => undefined);
      expect(calls).toBe(before); // capped at the cooldown: not before 30 s
    });
  });
}

function suppressedRefreshCases(k: Kit): void {
  describe("a refresh suppressed by the cooldown (review 9 L9)", () => {
    it("a made-up kid spends the cooldown; a real rotated kid inside it is unavailable, not 401", async () => {
      let t = 1_000_000;
      let phase = 0;
      const rotated: JSONWebKeySet = {
        keys: [{ ...TEST_JWKS.keys[0], kid: "new" }, ...TEST_JWKS.keys],
      };
      const keys = k.makeKeyStore(async () => (phase === 0 ? TEST_JWKS : rotated), {
        now: () => t,
      });
      await keys.current();
      t += 31_000;
      expect(await k.check(signJwt(accessClaims(), { kid: "bogus" }), keys)).toEqual({
        ok: false,
        reason: "unknown signing key",
      });
      phase = 1;
      t += 1_000;
      await expect(
        k.check(signJwt(accessClaims(), { kid: "new" }), keys)
      ).rejects.toBeInstanceOf(JwksUnavailableError);
      t += 30_000;
      expect((await k.check(signJwt(accessClaims(), { kid: "new" }), keys)).ok).toBe(
        true
      );
    });
  });
}

function unavailableKeyCases(k: Kit): void {
  describe("unavailable keys fall through to the token verifier (review 9 M4, L9)", () => {
    /** A provider whose key store starts with the pool's keys and then cannot refresh. */
    function failingKeys() {
      let up = true;
      let keyClock = 0;
      const keys = k.makeKeyStore(
        async () => {
          if (!up) throw new Error("JWKS down");
          return TEST_JWKS;
        },
        { now: () => keyClock, sleep: noSleep, staleMs: 1_000 }
      );
      return {
        p: k.provider(keys),
        keys,
        advance: (ms: number) => {
          up = false;
          keyClock += ms;
        },
      };
    }

    it("a fresh remembered verification of the token is honoured — no lookup", async () => {
      const { p, keys, advance } = failingKeys();
      const token = signJwt(accessClaims());
      await keys.current();
      expect(await p.verifyToken(token)).toMatchObject({ sub: "user-123" });
      expect(k.state.lookup).toHaveBeenCalledTimes(1);
      advance(5_000_000); // the keys now unobtainable (past the stale window)
      expect(await p.verifyToken(token)).toMatchObject({ sub: "user-123" });
      expect(await p.verifyToken(token, { privileged: true })).toMatchObject({
        sub: "user-123",
      });
      expect(k.state.lookup).toHaveBeenCalledTimes(1);
    });

    it("past the fresh window: the stale grace on an ordinary route; 503 on a privileged one", async () => {
      const { p, keys, advance } = failingKeys();
      const token = signJwt(accessClaims());
      await keys.current();
      await p.verifyToken(token);
      advance(5_000_000);
      k.state.clock = k.T0 + 60_000; // past fresh (30 s), inside the grace (300 s)
      expect(await p.verifyToken(token)).toMatchObject({ sub: "user-123" });
      await expect(p.verifyToken(token, { privileged: true })).rejects.toBeInstanceOf(
        TokenVerificationUnavailableError
      );
      expect(k.state.lookup).toHaveBeenCalledTimes(1);
    });

    it("no remembered verification: unavailable (503), never a 401 — and no lookup", async () => {
      const { p, advance } = failingKeys();
      advance(5_000_000);
      await expect(p.verifyToken(signJwt(accessClaims()))).rejects.toBeInstanceOf(
        TokenVerificationUnavailableError
      );
      expect(k.state.lookup).not.toHaveBeenCalled();
    });

    it("a revocation voids the stand-in even while the keys are unavailable", async () => {
      const { p, keys, advance } = failingKeys();
      const token = signJwt(accessClaims());
      await keys.current();
      await p.verifyToken(token);
      await revokeTokenVerification("user-123", k.state.shared);
      advance(5_000_000);
      await expect(p.verifyToken(token)).rejects.toBeInstanceOf(
        TokenVerificationUnavailableError
      );
    });
  });
}

function revocationDuringLookupCases(k: Kit): void {
  describe("an 'unavailable' lookup after a revocation during the call (review 9 L11)", () => {
    it("does not stand on the entry read before the revocation", async () => {
      const p = k.provider(k.pinnedKeys());
      const token = signJwt(accessClaims());
      expect(await p.verifyToken(token)).toMatchObject({ sub: "user-123" });
      k.state.clock = k.T0 + 60_000; // past fresh, inside the grace
      k.state.lookup.mockImplementation(async () => {
        // Revoked while the lookup is in flight; then the lookup cannot answer.
        await revokeTokenVerification("user-123", k.state.shared);
        return { kind: "unavailable", reason: "TooManyRequestsException" };
      });
      await expect(p.verifyToken(token)).rejects.toBeInstanceOf(
        TokenVerificationUnavailableError
      );
    });

    it("without a revocation the same outage stands on the entry (the grace)", async () => {
      const p = k.provider(k.pinnedKeys());
      const token = signJwt(accessClaims());
      await p.verifyToken(token);
      k.state.clock = k.T0 + 60_000;
      k.state.lookup.mockImplementation(async () => ({
        kind: "unavailable",
        reason: "x",
      }));
      expect(await p.verifyToken(token)).toMatchObject({ sub: "user-123" });
      // A privileged route never stands on it.
      await expect(p.verifyToken(token, { privileged: true })).rejects.toBeInstanceOf(
        TokenVerificationUnavailableError
      );
    });

    it("a stamp that cannot be read after the outage is no proof: no stand-in", async () => {
      let failStamp = false;
      const flaky: CacheProvider = new Proxy(k.state.shared, {
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
      const p = k.provider(k.pinnedKeys(), k.verifier(flaky));
      const token = signJwt(accessClaims());
      await p.verifyToken(token);
      k.state.clock = k.T0 + 60_000;
      k.state.lookup.mockImplementation(async () => {
        failStamp = true;
        return { kind: "unavailable", reason: "x" };
      });
      await expect(p.verifyToken(token)).rejects.toBeInstanceOf(
        TokenVerificationUnavailableError
      );
    });
  });
}
