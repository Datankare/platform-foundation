/**
 * @jest-environment node
 */
/**
 * __tests__/r10-jwks-cold-wait.test.ts — A cold instance never holds a request for the whole
 * backoff (review 10 M4)
 *
 * The reviewer's proof (review10/__tests__/r10/jwks-cold-sleep.test.ts): during a JWKS outage, a
 * cold instance (no keys yet) slept the full doubled backoff inside every request — up to the
 * 30 s cooldown per request. Now a request sleeps only what is left of the backoff since the last
 * attempt, at most COLD_WAIT_CAP_MS (1 s), and joins a fetch already in flight instead of
 * sleeping. Asserted with the reviewer's injected clock and with real (fake) timers.
 */

import {
  COLD_WAIT_CAP_MS,
  JwksKeyStore,
  JwksUnavailableError,
} from "@/platform/auth/jwt-verification";

describe("r10 M4: cold-instance waits are bounded per request", () => {
  it("the reviewer's case: no request sleeps more than 1 s (it slept up to 30 s)", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const store = new JwksKeyStore(
      async () => {
        throw new Error("down");
      },
      {
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
      }
    );
    const perRequest: number[] = [];
    for (let i = 0; i < 12; i++) {
      const before = sleeps.length;
      await expect(store.current()).rejects.toThrow(JwksUnavailableError);
      perRequest.push(sleeps.slice(before).reduce((a, b) => a + b, 0));
      t += 1; // the next request arrives 1 ms later
    }
    expect(COLD_WAIT_CAP_MS).toBe(1000);
    expect(Math.max(...perRequest)).toBeLessThanOrEqual(COLD_WAIT_CAP_MS);
  });

  it("under fake timers, with the default sleep: every request settles within 1 s", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      let fetches = 0;
      const store = new JwksKeyStore(async () => {
        fetches += 1;
        throw new Error("down");
      });
      for (let i = 0; i < 15; i++) {
        let settled = false;
        const started = Date.now();
        const p = store.current().then(
          () => (settled = true),
          () => (settled = true)
        );
        // Advance in small steps; the request must settle by the 1 s mark.
        for (let ms = 0; ms <= COLD_WAIT_CAP_MS && !settled; ms += 50) {
          await jest.advanceTimersByTimeAsync(50);
        }
        await p;
        expect(settled).toBe(true);
        expect(Date.now() - started).toBeLessThanOrEqual(COLD_WAIT_CAP_MS + 50);
        await jest.advanceTimersByTimeAsync(10);
      }
      // Still bounded fetching: the backoff doubles up to the cooldown, not one fetch per request.
      expect(fetches).toBeLessThan(30);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a request that meets a fetch in flight joins it instead of sleeping", async () => {
    let t = 0;
    const sleeps: number[] = [];
    let release!: () => void;
    let calls = 0;
    const store = new JwksKeyStore(
      () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("blip"));
        return new Promise((resolve) => {
          release = () =>
            resolve({ keys: [{ kty: "RSA", kid: "k", n: "x", e: "AQAB" }] });
        });
      },
      {
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
      }
    );
    // First request: the first fetch fails, it waits the 250 ms backoff and starts the second.
    const first = store.current();
    await new Promise((r) => setImmediate(r));
    // Second request arrives while that second fetch is in flight: it joins, no sleep of its own.
    const sleptBefore = sleeps.length;
    const second = store.current();
    await new Promise((r) => setImmediate(r));
    release();
    await expect(first).resolves.toEqual({
      keys: [expect.objectContaining({ kid: "k" })],
    });
    await expect(second).resolves.toEqual({
      keys: [expect.objectContaining({ kid: "k" })],
    });
    expect(sleeps.slice(sleptBefore)).toEqual([]);
    expect(calls).toBe(2);
  });
});
