/**
 * @jest-environment node
 */
/**
 * __tests__/rv11-jwks-budget.test.ts — One request waits at most 1 s for signing keys, in all
 * (review 11 L-6)
 *
 * Review 10 M4 capped the backoff a cold request sleeps, but a request that met a fetch in flight
 * joined it, and then started (or joined) a second: two 5 s fetch timeouts — about 10 s — on a
 * cold instance whose JWKS endpoint hangs. Now the whole wait — backoff, joins and fetches — is
 * bounded by COLD_WAIT_CAP_MS per request; past it the keys held (within their stale period) are
 * used, or the answer is "unavailable". The fetch itself completes for the requests after.
 */

import {
  COLD_WAIT_CAP_MS,
  JwksKeyStore,
  JwksUnavailableError,
} from "@/platform/auth/jwt-verification";

const KEYS = { keys: [{ kty: "RSA", kid: "k", n: "x", e: "AQAB" }] };

/** A JWKS endpoint that answers only after `ms` (its own 5 s timeout, say). */
const slowFetch = (ms: number, answer: () => unknown) => () =>
  new Promise<never>((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(answer() as never);
      } catch (e) {
        reject(e);
      }
    }, ms)
  );

async function settleWithin<T>(p: Promise<T>, budget: number): Promise<number> {
  const started = Date.now();
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true)
  );
  for (let ms = 0; ms <= budget + 50 && !settled; ms += 50) {
    await jest.advanceTimersByTimeAsync(50);
  }
  expect(settled).toBe(true);
  return Date.now() - started;
}

describe("rv11 L-6: the per-request wait for signing keys is bounded in all", () => {
  beforeEach(() => jest.useFakeTimers({ now: 5_000_000 }));
  afterEach(() => jest.useRealTimers());

  it("a cold request facing a hanging endpoint (5 s per fetch) is answered 'unavailable' within 1 s — so is one that joins it", async () => {
    let fetches = 0;
    const hanging = slowFetch(5000, () => {
      throw new Error("timed out");
    });
    const store = new JwksKeyStore(() => {
      fetches += 1;
      return hanging();
    });
    const first = store.current();
    const firstDone = first.catch((e: unknown) => e);
    expect(await settleWithin(first, COLD_WAIT_CAP_MS)).toBeLessThanOrEqual(
      COLD_WAIT_CAP_MS + 50
    );
    expect(await firstDone).toBeInstanceOf(JwksUnavailableError);
    // Joining the fetch still in flight: bounded the same way.
    const second = store.current();
    const secondDone = second.catch((e: unknown) => e);
    expect(await settleWithin(second, COLD_WAIT_CAP_MS)).toBeLessThanOrEqual(
      COLD_WAIT_CAP_MS + 50
    );
    expect(await secondDone).toBeInstanceOf(JwksUnavailableError);
    // One fetch, still under way, joined — never a second beside it.
    expect(fetches).toBe(1);
  });

  it("the fetch completes for the requests after: once it answers, keys are served at once", async () => {
    const store = new JwksKeyStore(slowFetch(3000, () => KEYS));
    const first = store.current().catch((e: unknown) => e);
    await settleWithin(first, COLD_WAIT_CAP_MS);
    expect(await first).toBeInstanceOf(JwksUnavailableError);
    await jest.advanceTimersByTimeAsync(3000);
    const later = store.current();
    expect(await settleWithin(later, 0)).toBeLessThanOrEqual(50);
    await expect(later).resolves.toEqual(KEYS);
  });

  it("warm but old keys: a slow refresh does not hold the request — the keys held stand in", async () => {
    let calls = 0;
    const store = new JwksKeyStore(
      () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(KEYS) : slowFetch(5000, () => KEYS)();
      },
      { maxAgeMs: 1000 }
    );
    await expect(store.current()).resolves.toEqual(KEYS);
    await jest.advanceTimersByTimeAsync(31_000); // past maxAge and the cooldown
    const req = store.current();
    expect(await settleWithin(req, COLD_WAIT_CAP_MS)).toBeLessThanOrEqual(
      COLD_WAIT_CAP_MS + 50
    );
    await expect(req).resolves.toEqual(KEYS);
  });

  it("an unknown key's refresh, joined while it hangs, answers 'not refreshed' (unavailable) within 1 s", async () => {
    let calls = 0;
    const store = new JwksKeyStore(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(KEYS) : slowFetch(5000, () => KEYS)();
    });
    await store.current();
    await jest.advanceTimersByTimeAsync(31_000); // past the cooldown
    const a = store.refreshForUnknownKey();
    expect(await settleWithin(a, COLD_WAIT_CAP_MS)).toBeLessThanOrEqual(
      COLD_WAIT_CAP_MS + 50
    );
    await expect(a).resolves.toBe(false);
    const b = store.refreshForUnknownKey();
    expect(await settleWithin(b, COLD_WAIT_CAP_MS)).toBeLessThanOrEqual(
      COLD_WAIT_CAP_MS + 50
    );
    await expect(b).resolves.toBe(false);
  });
});
