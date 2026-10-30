/**
 * __tests__/token-verification.test.ts — a verified access token, remembered briefly
 * (platform/auth/token-verification.ts)
 *
 * Cognito's GetUser was called on every request, one AWS call each, under a per-account rate
 * quota: exhausted, every request failed. The outcome is now remembered in the shared cache,
 * keyed by a hash of the token, for a short governed window never past the token's expiry;
 * revoked at once on every instance (two instances here share one cache, as Upstash makes them);
 * asked once per token per instance at a time; and when Cognito cannot answer, a privileged
 * route fails closed (503) while an ordinary one may stand on a recent verification.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import fc from "fast-check";
import { NextRequest } from "next/server";
import { InMemoryCacheProvider } from "@/platform/cache/memory-cache";
import type { CacheProvider } from "@/platform/cache/types";
import {
  TokenVerificationUnavailableError,
  TokenVerifier,
  forgetTokenVerification,
  revokeTokenVerification,
  tokenKey,
  tokenSubject,
  type ProviderOutcome,
} from "@/platform/auth/token-verification";
import { cognitoUnavailable, CognitoError } from "@/platform/auth/cognito-provider";
import type { TokenPayload } from "@/platform/auth/types";
import { fuzzParams } from "./helpers/fuzz";

fc.configureGlobal(fuzzParams());

const T0 = 1_800_000_000_000; // ms
const SUB = "user-1";
const payload = (over: Partial<TokenPayload> = {}): TokenPayload =>
  ({
    sub: SUB,
    email: "u@x.y",
    emailVerified: true,
    iat: 0,
    exp: T0 / 1000 + 3600,
    mfaEnabled: true,
    ...over,
  }) as TokenPayload;

let clock = T0;
let space = 0;
let shared: CacheProvider;
const settings = { freshSeconds: 30, graceSeconds: 300 };
const instance = () =>
  new TokenVerifier({
    cache: () => shared,
    settings: async () => settings,
    now: () => clock,
  });
const claims = (exp = T0 / 1000 + 3600) => ({ exp, subject: SUB });
const valid = (p = payload()) =>
  jest.fn(async (): Promise<ProviderOutcome> => ({ kind: "valid", payload: p }));
const unavailable = () =>
  jest.fn(async (): Promise<ProviderOutcome> => ({
    kind: "unavailable",
    reason: "TooManyRequestsException",
  }));

beforeEach(() => {
  clock = T0;
  shared = new InMemoryCacheProvider({ namespace: `tv-${++space}` });
  settings.freshSeconds = 30;
  settings.graceSeconds = 300;
});

describe("remembering a verification", () => {
  it("answers a repeat within the fresh window from the cache: one GetUser", async () => {
    const v = instance();
    const ask = valid();
    expect(await v.verify("tok", claims(), ask)).toMatchObject({ sub: SUB });
    clock += 29_000;
    expect(await v.verify("tok", claims(), ask)).toMatchObject({ sub: SUB });
    expect(ask).toHaveBeenCalledTimes(1);
    clock += 2_000;
    await v.verify("tok", claims(), ask);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("keys by a hash of the token, never the token", async () => {
    await instance().verify("secret-token", claims(), valid());
    expect(tokenKey("secret-token")).toMatch(/^auth:token:v1:[0-9a-f]{64}$/);
    expect(tokenKey("secret-token")).not.toContain("secret-token");
    expect(await shared.get(tokenKey("secret-token"))).not.toBeNull();
  });

  it("a second instance answers from what the first verified (the shared cache)", async () => {
    await instance().verify("tok", claims(), valid());
    const ask = valid();
    expect(await instance().verify("tok", claims(), ask)).toMatchObject({ sub: SUB });
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks once per token per instance at a time (single flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ask = jest.fn(async (): Promise<ProviderOutcome> => {
      await gate;
      return { kind: "valid", payload: payload() };
    });
    const v = instance();
    const all = Promise.all([1, 2, 3, 4, 5].map(() => v.verify("tok", claims(), ask)));
    await new Promise((r) => setTimeout(r, 5));
    release();
    const verified = await all;
    expect(verified).toHaveLength(5);
    expect(verified.every((p) => p?.sub === SUB)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("never remembers past the token's expiry, nor longer than fresh + grace", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 900 }),
        async (expIn, fresh, grace) => {
          shared = new InMemoryCacheProvider({ namespace: `tv-p-${++space}` });
          settings.freshSeconds = fresh;
          settings.graceSeconds = grace;
          const set = jest.spyOn(shared, "set");
          await instance().verify("tok", claims(T0 / 1000 + expIn), valid());
          const call = set.mock.calls.find((c) =>
            String(c[0]).startsWith("auth:token:v1:")
          );
          const ttl = (call?.[2] as { ttlSeconds: number } | undefined)?.ttlSeconds ?? 0;
          return ttl <= expIn && ttl <= fresh + grace && ttl >= 1;
        }
      )
    );
  });

  it("refuses an expired token without asking", async () => {
    const ask = valid();
    expect(await instance().verify("tok", claims(T0 / 1000 - 1), ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("an entry past the token's expiry is never served", async () => {
    const v = instance();
    await v.verify("tok", claims(T0 / 1000 + 10), valid());
    clock += 11_000;
    expect(await v.verify("tok", claims(T0 / 1000 + 10), valid())).toBeNull();
  });

  it("with the window set to 0, always asks and remembers nothing", async () => {
    settings.freshSeconds = 0;
    const v = instance();
    const ask = valid();
    await v.verify("tok", claims(), ask);
    await v.verify("tok", claims(), ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(await shared.get(tokenKey("tok"))).toBeNull();
  });

  it("forgets a token the provider no longer accepts", async () => {
    const v = instance();
    await v.verify("tok", claims(), valid());
    clock += 31_000;
    expect(await v.verify("tok", claims(), async () => ({ kind: "invalid" }))).toBeNull();
    expect(await shared.get(tokenKey("tok"))).toBeNull();
  });

  it("does not serve an entry for another subject than the token names", async () => {
    await instance().verify("tok", claims(), valid());
    const ask = valid(payload({ sub: "user-2" }));
    await instance().verify("tok", { exp: claims().exp, subject: "user-2" }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("revocation reaches every instance at once", () => {
  it("a sign-out on one instance voids the other's next answer", async () => {
    const a = instance();
    const b = instance();
    await a.verify("tok", claims(), valid());
    await revokeTokenVerification(SUB, shared);
    const ask = valid();
    await b.verify("tok", claims(), ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a revocation during GetUser voids what it answered (the stamp is read first)", async () => {
    const v = instance();
    const ask = jest.fn(async (): Promise<ProviderOutcome> => {
      await revokeTokenVerification(SUB, shared);
      return { kind: "valid", payload: payload() };
    });
    await v.verify("tok", claims(), ask);
    const again = valid();
    await v.verify("tok", claims(), again);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("forgetting one token removes it", async () => {
    await instance().verify("tok", claims(), valid());
    await forgetTokenVerification("tok", shared);
    expect(await shared.get(tokenKey("tok"))).toBeNull();
  });

  it("an unreadable cache is a miss: GetUser is asked", async () => {
    const broken = {
      ...new InMemoryCacheProvider(),
      get: async () => {
        throw new Error("cache down");
      },
      set: async () => {
        throw new Error("cache down");
      },
      delete: async () => false,
    } as unknown as CacheProvider;
    const v = new TokenVerifier({
      cache: () => broken,
      settings: async () => settings,
      now: () => clock,
    });
    const ask = valid();
    expect(await v.verify("tok", claims(), ask)).toMatchObject({ sub: SUB });
    expect(await v.verify("tok", claims(), ask)).toMatchObject({ sub: SUB });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("reads the subject a revocation is addressed to from the token", () => {
    const jwt = (c: object) =>
      `h.${Buffer.from(JSON.stringify(c)).toString("base64url")}.s`;
    // TASK-177: the sub, never the username (a federated user's is Google_…).
    expect(tokenSubject(jwt({ username: "Google_1093", sub: "u-sub" }))).toBe("u-sub");
    expect(tokenSubject(jwt({ sub: "u-sub" }))).toBe("u-sub");
    expect(tokenSubject(jwt({ username: "u-name" }))).toBeUndefined();
    expect(tokenSubject("not a token")).toBeUndefined();
  });
});

describe("when the identity provider cannot answer (the quota, an outage)", () => {
  it("a privileged route fails closed, even on a fresh-expired recent entry", async () => {
    const v = instance();
    await v.verify("tok", claims(), valid());
    clock += 31_000;
    await expect(
      v.verify("tok", claims(), unavailable(), { privileged: true })
    ).rejects.toBeInstanceOf(TokenVerificationUnavailableError);
  });

  it("an ordinary route stands on a recent verification within the grace", async () => {
    const v = instance();
    await v.verify("tok", claims(), valid());
    clock += 200_000;
    expect(await v.verify("tok", claims(), unavailable())).toMatchObject({ sub: SUB });
  });

  it("not past the grace, not past the token's expiry, not after a revocation", async () => {
    const v = instance();
    await v.verify("tok", claims(), valid());
    clock += 331_000;
    await expect(v.verify("tok", claims(), unavailable())).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );

    clock = T0;
    await v.verify("tok2", claims(T0 / 1000 + 60), valid());
    clock += 61_000;
    expect(await v.verify("tok2", claims(T0 / 1000 + 60), unavailable())).toBeNull();

    clock = T0;
    await v.verify("tok3", claims(), valid());
    await revokeTokenVerification(SUB, shared);
    clock += 40_000;
    await expect(v.verify("tok3", claims(), unavailable())).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );
  });

  it("with no recent verification, every route fails closed", async () => {
    await expect(
      instance().verify("tok", claims(), unavailable())
    ).rejects.toBeInstanceOf(TokenVerificationUnavailableError);
    await expect(
      instance().verify("tok", claims(), async () => {
        throw new Error("socket hang up");
      })
    ).rejects.toBeInstanceOf(TokenVerificationUnavailableError);
  });

  it("classifies Cognito's failures: throttling and outages are not an invalid token", () => {
    for (const type of [
      "TooManyRequestsException",
      "LimitExceededException",
      "InternalErrorException",
      "TimeoutError",
      "NetworkError",
    ])
      expect([type, cognitoUnavailable(new CognitoError("x", type, 400))]).toEqual([
        type,
        true,
      ]);
    expect(cognitoUnavailable(new CognitoError("x", "Unknown", 503))).toBe(true);
    expect(cognitoUnavailable(new CognitoError("x", "NotAuthorizedException", 400))).toBe(
      false
    );
    expect(cognitoUnavailable(new CognitoError("x", "UserNotFoundException", 400))).toBe(
      false
    );
  });
});

describe("the request guard", () => {
  it("answers 503 service.unavailable (auth), never 401, when verification is unavailable", async () => {
    jest.resetModules();
    jest.doMock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));
    jest.doMock("@/platform/auth/config", () => {
      const actual = jest.requireActual("@/platform/auth/config");
      const { TokenVerificationUnavailableError: E } = jest.requireActual(
        "@/platform/auth/token-verification"
      );
      const calls: unknown[] = [];
      return {
        ...actual,
        __calls: calls,
        getAuthProvider: () => ({
          verifyToken: async (_t: string, options: unknown) => {
            calls.push(options);
            throw new E("TooManyRequestsException");
          },
        }),
      };
    });
    const { requireAuth } = await import("@/platform/auth/middleware");
    const res = await requireAuth(
      new NextRequest("http://localhost/api/x", {
        headers: { authorization: "Bearer a.b.c" },
      }),
      { privileged: true }
    );
    expect(res.error?.status).toBe(503);
    expect((await res.error!.json()).code).toBe("service.unavailable");
    const provider = (await import("@/platform/auth/config")) as unknown as {
      __calls: unknown[];
    };
    expect(provider.__calls).toEqual([{ privileged: true }]);
    jest.dontMock("@/platform/auth/config");
    jest.dontMock("@/platform/auth/auth-init");
  });

  it("the administrative guard verifies as privileged", () => {
    const src = jest
      .requireActual<typeof import("fs")>("fs")
      .readFileSync("platform/auth/admin-guard.ts", "utf8");
    expect(src).toMatch(/requireAuth\(request, \{ privileged: true \}\)/);
  });

  // Review 8 M5: the account's own export and deletion, and changes to how it signs in (MFA),
  // fail closed too — a stale verification never exports, deletes or changes MFA.
  it.each([
    [
      "app/api/account/export/route.ts",
      /requireActor\(request, \{ allowGuests: false, privileged: true \}\)/,
    ],
    [
      "app/api/account/delete/route.ts",
      /requireActor\(request, \{ allowGuests: false, privileged: true \}\)/,
    ],
    ["app/api/auth/mfa/setup/route.ts", /requireAuth\(request, \{ privileged: true \}\)/],
    [
      "app/api/auth/mfa/disable/route.ts",
      /requireAuth\(request, \{ privileged: true \}\)/,
    ],
    [
      "app/api/auth/mfa/verify/route.ts",
      /requireAuth\(request, \{ privileged: true \}\)/,
    ],
  ])("%s verifies as privileged", (file, form) => {
    const src = jest.requireActual<typeof import("fs")>("fs").readFileSync(file, "utf8");
    expect(src).toMatch(form);
  });

  it("requireActor passes privileged on to the provider (and not otherwise)", async () => {
    jest.resetModules();
    jest.doMock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));
    const calls: unknown[] = [];
    jest.doMock("@/platform/auth/config", () => {
      const actual = jest.requireActual("@/platform/auth/config");
      const { TokenVerificationUnavailableError: E } = jest.requireActual(
        "@/platform/auth/token-verification"
      );
      return {
        ...actual,
        getAuthProvider: () => ({
          verifyToken: async (_t: string, options: unknown) => {
            calls.push(options);
            throw new E("TooManyRequestsException");
          },
        }),
      };
    });
    const { requireActor } = await import("@/platform/auth/middleware");
    const req = () =>
      new NextRequest("http://localhost/api/account/export", {
        headers: { authorization: "Bearer a.b.c" },
      });
    const res = await requireActor(req(), { allowGuests: false, privileged: true });
    expect(res.error?.status).toBe(503);
    await requireActor(req(), { allowGuests: false });
    expect(calls).toEqual([{ privileged: true }, { privileged: false }]);
    jest.dontMock("@/platform/auth/config");
    jest.dontMock("@/platform/auth/auth-init");
  });
});

// TASK-185: the account's address moves to a different one only from the provider's own answer
// to this request — so the verifier marks exactly that answer, and nothing it remembers.
describe("addressFresh: only the provider's own answer to this request", () => {
  it("a GetUser answer is marked fresh; the same token answered from memory is not", async () => {
    const v = instance();
    const ask = valid();
    expect(await v.verify("tok", claims(), ask)).toMatchObject({ addressFresh: true });
    clock += 1_000;
    const again = await v.verify("tok", claims(), ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveProperty("addressFresh");
  });

  it("the flag is never stored, even when the provider itself set one", async () => {
    await instance().verify("tok", claims(), valid(payload({ addressFresh: true })));
    const stored = await shared.get<{ payload: TokenPayload }>(tokenKey("tok"));
    expect(stored?.payload).not.toHaveProperty("addressFresh");
    // Another instance, sharing the cache, answers from memory: not fresh.
    expect(await instance().verify("tok", claims(), valid())).not.toHaveProperty(
      "addressFresh"
    );
  });

  it("a stand-in while the provider cannot answer is not fresh", async () => {
    const v = instance();
    await v.verify("tok", claims(), valid());
    clock += 60_000; // past fresh, within grace
    const standIn = await v.verify("tok", claims(), unavailable());
    expect(standIn).toMatchObject({ sub: SUB });
    expect(standIn).not.toHaveProperty("addressFresh");
  });

  it("with remembering off, every answer is the provider's own: fresh", async () => {
    settings.freshSeconds = 0;
    const v = instance();
    expect(await v.verify("tok", claims(), valid())).toMatchObject({
      addressFresh: true,
    });
    expect(await v.verify("tok", claims(), valid())).toMatchObject({
      addressFresh: true,
    });
  });
});
