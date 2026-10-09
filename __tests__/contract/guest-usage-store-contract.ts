/**
 * __tests__/contract/guest-usage-store-contract.ts — GuestUsageStore conformance (ADR-027, ADR-050 D4)
 *
 * What every guest-usage store must guarantee for the allowance to bind:
 *   - consume counts one unit and reports the total after it;
 *   - at the limit it refuses and writes nothing;
 *   - concurrent consumes never exceed the limit;
 *   - guests are counted independently; reset clears everything.
 */

import type { GuestUsageStore } from "@/platform/auth/guest-allowance";

const A = "guest_" + "a".repeat(32);
const B = "guest_" + "b".repeat(32);

export interface GuestUsageStoreContractFixtures {
  /** Fresh, empty store per test. */
  makeStore: () => GuestUsageStore | Promise<GuestUsageStore>;
}

export function runGuestUsageStoreContract(fx: GuestUsageStoreContractFixtures): void {
  let store: GuestUsageStore;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  it("an unseen guest has used nothing", async () => {
    await expect(store.used(A)).resolves.toBe(0);
  });

  it("consume counts one unit and returns the total after it", async () => {
    await expect(store.consume(A, 5)).resolves.toEqual({ allowed: true, used: 1 });
    await expect(store.consume(A, 5)).resolves.toEqual({ allowed: true, used: 2 });
    await expect(store.used(A)).resolves.toBe(2);
  });

  it("at the limit it refuses and writes nothing", async () => {
    await store.consume(A, 2);
    await store.consume(A, 2);
    await expect(store.consume(A, 2)).resolves.toEqual({ allowed: false, used: 2 });
    await expect(store.used(A)).resolves.toBe(2);
  });

  it("concurrent consumes never exceed the limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.consume(A, 4))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(4);
    await expect(store.used(A)).resolves.toBe(4);
  });

  it("counts guests independently", async () => {
    await store.consume(A, 1);
    await expect(store.consume(B, 1)).resolves.toEqual({ allowed: true, used: 1 });
  });

  it("a raised limit lets a guest continue from where they were", async () => {
    await store.consume(A, 1);
    await expect(store.consume(A, 1)).resolves.toEqual({ allowed: false, used: 1 });
    await expect(store.consume(A, 2)).resolves.toEqual({ allowed: true, used: 2 });
  });

  it("reset clears every guest", async () => {
    await store.consume(A, 3);
    await store.consume(B, 3);
    await store.reset();
    await expect(store.used(A)).resolves.toBe(0);
    await expect(store.used(B)).resolves.toBe(0);
  });
}
