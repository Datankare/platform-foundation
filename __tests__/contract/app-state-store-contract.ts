/**
 * __tests__/contract/app-state-store-contract.ts
 * ActivityStateStore conformance kit (TCK) — ADR-027 + ADR-028 D5. Not a *.test.ts.
 *
 * The concurrency arm is the load-bearing part: it races commits to prove the
 * atomicity contract (D5). A store that passes single-threaded CRUD but fails
 * concurrency is unsafe and must not register.
 */

import type { ActivityStateStore } from "@/platform/app-framework/state-store";

interface CounterState {
  count: number;
}

export interface AppStateStoreContractFixtures {
  /** Fresh store per test. Generic collapsed to CounterState for concrete fixtures. */
  makeStore: () =>
    | ActivityStateStore<CounterState>
    | Promise<ActivityStateStore<CounterState>>;
}

export function runAppStateStoreContract(fx: AppStateStoreContractFixtures): void {
  let store: ActivityStateStore<CounterState>;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  describe("create / load", () => {
    it("creates at version 1 and loads it back", async () => {
      const created = await store.create("s1", { count: 0 });
      expect(created.version).toBe(1);
      const loaded = await store.load("s1");
      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe(1);
      expect(loaded?.state.count).toBe(0);
    });

    it("returns null for an unknown session", async () => {
      expect(await store.load("nope")).toBeNull();
    });

    it("rejects creating an existing session", async () => {
      await store.create("s1", { count: 0 });
      await expect(store.create("s1", { count: 0 })).rejects.toThrow();
    });
  });

  describe("commit (CAS)", () => {
    it("commits against the current version and bumps it", async () => {
      await store.create("s1", { count: 0 });
      const res = await store.commit("s1", 1, { count: 5 }, "op-1");
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.version).toBe(2);
      const loaded = await store.load("s1");
      expect(loaded?.state.count).toBe(5);
      expect(loaded?.version).toBe(2);
    });

    it("records producedBy for reconstructibility (D2)", async () => {
      await store.create("s1", { count: 0 });
      await store.commit("s1", 1, { count: 5 }, "op-abc");
      const loaded = await store.load("s1");
      expect(loaded?.producedBy).toBe("op-abc");
    });

    it("rejects a stale version and returns fresh state (D5)", async () => {
      await store.create("s1", { count: 0 });
      await store.commit("s1", 1, { count: 5 }, "op-1");
      const stale = await store.commit("s1", 1, { count: 99 }, "op-2");
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.currentVersion).toBe(2);
        expect(stale.currentState.count).toBe(5);
      }
    });
  });

  describe("concurrency (the atomicity contract — D5)", () => {
    it("exactly one of two concurrent commits at the same version wins", async () => {
      await store.create("s1", { count: 0 });
      const [a, b] = await Promise.all([
        store.commit("s1", 1, { count: 10 }, "op-a"),
        store.commit("s1", 1, { count: 20 }, "op-b"),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const loaded = await store.load("s1");
      expect(loaded?.version).toBe(2); // exactly one increment, not two
    });

    it("reduceCommit composes concurrent increments without loss", async () => {
      await store.create("s1", { count: 0 });
      const inc = (s: CounterState): CounterState => ({ count: s.count + 1 });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.reduceCommit("s1", inc, `op-${i}`))
      );
      const loaded = await store.load("s1");
      expect(loaded?.state.count).toBe(10); // all 10 applied, none lost
    });

    it("reduceCommit is order-independent (associativity)", async () => {
      await store.create("s1", { count: 0 });
      const add =
        (n: number) =>
        (s: CounterState): CounterState => ({ count: s.count + n });
      await Promise.all([
        store.reduceCommit("s1", add(3), "op-1"),
        store.reduceCommit("s1", add(5), "op-2"),
        store.reduceCommit("s1", add(7), "op-3"),
      ]);
      const loaded = await store.load("s1");
      expect(loaded?.state.count).toBe(15); // 3+5+7 regardless of order
    });
  });

  describe("delete", () => {
    it("hard-purges session state (GDPR)", async () => {
      await store.create("s1", { count: 1 });
      await store.delete("s1");
      expect(await store.load("s1")).toBeNull();
    });
  });
}
