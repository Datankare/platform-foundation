/**
 * __tests__/token-verification-race.test.ts — a revocation during an in-flight GetUser
 * (review 8 H-A; platform/auth/token-verification.ts)
 *
 * The reviewer's proof: request A's GetUser is in flight; the user signs out (GlobalSignOut, then
 * the revocation stamp is published); request B arrives, reads the NEW stamp and joined A's
 * flight — then saved A's pre-sign-out answer under the new stamp, so the signed-out token was
 * served from the cache for the fresh window. Now a request joins only a flight asked under the
 * stamp it read itself, and an answer is saved only when its stamp is still current after it
 * answered. The same holds for an MFA or role change (each publishes a revocation): a joiner
 * that arrives after it gets the provider's new answer, never the old one from the cache.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { InMemoryCacheProvider } from "@/platform/cache/memory-cache";
import {
  TokenVerificationUnavailableError,
  TokenVerifier,
  revokeTokenVerification,
  tokenKey,
  type ProviderOutcome,
} from "@/platform/auth/token-verification";
import type { TokenPayload } from "@/platform/auth/types";

const T0 = 1_800_000_000_000;
const SUB = "user-1";
const p = (over: Partial<TokenPayload> = {}): TokenPayload =>
  ({
    sub: SUB,
    email: "u@x.y",
    emailVerified: true,
    iat: 0,
    exp: T0 / 1000 + 3600,
    mfaEnabled: true,
    ...over,
  }) as TokenPayload;
const claims = { exp: T0 / 1000 + 3600, subject: SUB };
const tick = () => new Promise((r) => setImmediate(r));

/** A provider whose answers are released by hand, in the order they were asked. */
function slowProvider() {
  const pending: ((o: ProviderOutcome) => void)[] = [];
  const ask = jest.fn(
    () => new Promise<ProviderOutcome>((resolve) => pending.push(resolve))
  );
  return {
    ask,
    release: (i: number, o: ProviderOutcome) => pending[i](o),
    asked: () => pending.length,
  };
}

let clock: number;
let shared: InMemoryCacheProvider;
let space = 0;
const verifier = () =>
  new TokenVerifier({
    cache: () => shared,
    settings: async () => ({ freshSeconds: 30, graceSeconds: 300 }),
    now: () => clock,
  });

beforeEach(() => {
  clock = T0;
  shared = new InMemoryCacheProvider({ namespace: `r8-${++space}:` });
});

describe("a request after a revocation never takes a pre-revocation answer (H-A)", () => {
  it("sign-out: the joiner asks for itself, and the signed-out token is not served from the cache", async () => {
    const v = verifier();
    const provider = slowProvider();
    // A: GetUser in flight, started before the sign-out.
    const a = v.verify("tok", claims, provider.ask);
    await tick();
    // The sign-out: GlobalSignOut done, the stamp published.
    await revokeTokenVerification(SUB, shared);
    // B arrives after it, reads the new stamp: it does not join A's call.
    const b = v.verify("tok", claims, provider.ask);
    await tick();
    expect(provider.asked()).toBe(2);
    provider.release(0, { kind: "valid", payload: p() }); // answered before GlobalSignOut
    await tick();
    // A sees the stamp changed while it was answered and asks again — joining B's call.
    expect(provider.asked()).toBe(2);
    provider.release(1, { kind: "invalid" }); // asked after GlobalSignOut
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(await shared.get(tokenKey("tok"))).toBeNull();

    // C, later: nothing was saved, so the provider is asked — and says signed out.
    clock += 10_000;
    const revokedNow = jest.fn(async (): Promise<ProviderOutcome> => ({
      kind: "invalid",
    }));
    const c = await v.verify("tok", claims, revokedNow);
    expect({ c, askedAgain: revokedNow.mock.calls.length }).toEqual({
      c: null,
      askedAgain: 1,
    });
  });

  it("MFA change: a request after it gets the provider's new MFA setting, now and from the cache", async () => {
    const v = verifier();
    const provider = slowProvider();
    const a = v.verify("tok", claims, provider.ask);
    await tick();
    await revokeTokenVerification(SUB, shared); // MFA disabled (mfa-routes revokes)
    const b = v.verify("tok", claims, provider.ask);
    await tick();
    provider.release(0, { kind: "valid", payload: p({ mfaEnabled: true }) });
    await tick();
    provider.release(1, { kind: "valid", payload: p({ mfaEnabled: false }) });
    expect((await b)?.mfaEnabled).toBe(false);
    expect((await a)?.mfaEnabled).toBe(false); // A asked again under the new stamp
    clock += 5_000;
    const ask = jest.fn();
    expect((await v.verify("tok", claims, ask))?.mfaEnabled).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("role change: the remembered answer is the one asked after the change", async () => {
    const v = verifier();
    const provider = slowProvider();
    const a = v.verify("tok", claims, provider.ask);
    await tick();
    await revokeTokenVerification(SUB, shared); // a role change (permissions-cache revokes)
    const b = v.verify("tok", claims, provider.ask);
    await tick();
    provider.release(0, { kind: "valid", payload: p({ email: "before@x.y" }) });
    await tick();
    provider.release(1, { kind: "valid", payload: p({ email: "after@x.y" }) });
    await Promise.all([a, b]);
    expect(
      (await shared.get<{ payload: TokenPayload }>(tokenKey("tok")))?.payload.email
    ).toBe("after@x.y");
  });

  it("with no joiner: the starter itself asks again when a revocation landed during its call", async () => {
    const v = verifier();
    let n = 0;
    const ask = jest.fn(async (): Promise<ProviderOutcome> => {
      n++;
      if (n === 1) {
        await revokeTokenVerification(SUB, shared);
        return { kind: "valid", payload: p() };
      }
      return { kind: "invalid" };
    });
    expect(await v.verify("tok", claims, ask)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("requests under one stamp still share one call (single flight is kept)", async () => {
    const v = verifier();
    const provider = slowProvider();
    const all = Promise.all([1, 2, 3].map(() => v.verify("tok", claims, provider.ask)));
    await tick();
    expect(provider.asked()).toBe(1);
    provider.release(0, { kind: "valid", payload: p() });
    const verified = await all;
    expect(verified).toHaveLength(3);
    expect(verified.every((r) => r?.sub === SUB)).toBe(true);
  });

  it("an outage on the re-ask never falls back to the entry the revocation voided", async () => {
    const v = verifier();
    await v.verify("tok", claims, async () => ({ kind: "valid", payload: p() }));
    clock += 31_000; // past fresh, within grace
    let n = 0;
    const ask = jest.fn(async (): Promise<ProviderOutcome> => {
      n++;
      if (n === 1) {
        await revokeTokenVerification(SUB, shared);
        return { kind: "valid", payload: p() };
      }
      return { kind: "unavailable", reason: "TooManyRequestsException" };
    });
    await expect(v.verify("tok", claims, ask)).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError
    );
  });
});
