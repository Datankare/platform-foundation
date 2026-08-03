/**
 * __tests__/contract/budget-store-contract.ts
 * BudgetStore conformance kit (TCK) — ADR-027 + ADR-029 D8. Not a *.test.ts.
 *
 * The concurrency arm is the load-bearing one. BudgetStore.increment is specified as
 * atomic add-and-return, and nothing in the type system enforces that: an implementation
 * can read, add in application code, and write back, and it will typecheck. That
 * implementation loses concurrent increments, which makes a spend counter under-report —
 * it fails open, in the direction of overspending. A store that cannot accumulate
 * concurrently must not register.
 */

import type { BudgetScope, BudgetStore } from "@/platform/agents/budget-tracker";

const PERIOD = "2026-07-29";

function scope(overrides: Partial<BudgetScope> = {}): BudgetScope {
  return {
    agentId: "guardian",
    scopeType: "group",
    scopeId: "g1",
    period: PERIOD,
    ...overrides,
  };
}

export interface BudgetStoreContractFixtures {
  /** Fresh, empty store per test. */
  makeStore: () => BudgetStore | Promise<BudgetStore>;
}

export function runBudgetStoreContract(fx: BudgetStoreContractFixtures): void {
  let store: BudgetStore;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  describe("read", () => {
    it("returns zero usage for a scope never written", async () => {
      const usage = await store.read(scope());
      expect(usage.usedUsd).toBe(0);
      expect(usage.usedSteps).toBe(0);
    });
  });

  describe("increment", () => {
    it("returns the totals after the increment, not before", async () => {
      const usage = await store.increment(scope(), 0.25, 1);
      expect(usage.usedUsd).toBeCloseTo(0.25, 6);
      expect(usage.usedSteps).toBe(1);
    });

    it("accumulates across calls", async () => {
      await store.increment(scope(), 0.25, 1);
      await store.increment(scope(), 0.5, 1);
      const usage = await store.read(scope());
      expect(usage.usedUsd).toBeCloseTo(0.75, 6);
      expect(usage.usedSteps).toBe(2);
    });

    it("keeps sub-cent precision", async () => {
      // Four decimal places would truncate this to zero and a cheap-but-frequent agent
      // would accumulate nothing against its cap.
      for (let i = 0; i < 10; i++) {
        await store.increment(scope(), 0.000001, 1);
      }
      const usage = await store.read(scope());
      expect(usage.usedUsd).toBeCloseTo(0.00001, 9);
    });

    it("loses no increment under concurrency (atomicity contract)", async () => {
      await Promise.all(
        Array.from({ length: 20 }, () => store.increment(scope(), 0.01, 1))
      );
      const usage = await store.read(scope());
      expect(usage.usedUsd).toBeCloseTo(0.2, 6);
      expect(usage.usedSteps).toBe(20);
    });
  });

  describe("scope separation", () => {
    it("separates by agentId", async () => {
      await store.increment(scope({ agentId: "guardian" }), 0.05, 1);
      await store.increment(scope({ agentId: "matchmaker" }), 0.01, 1);
      expect((await store.read(scope({ agentId: "guardian" }))).usedUsd).toBeCloseTo(
        0.05,
        6
      );
      expect((await store.read(scope({ agentId: "matchmaker" }))).usedUsd).toBeCloseTo(
        0.01,
        6
      );
    });

    it("separates by scopeId", async () => {
      await store.increment(scope({ scopeId: "g1" }), 0.05, 1);
      await store.increment(scope({ scopeId: "g2" }), 0.01, 1);
      expect((await store.read(scope({ scopeId: "g1" }))).usedUsd).toBeCloseTo(0.05, 6);
      expect((await store.read(scope({ scopeId: "g2" }))).usedUsd).toBeCloseTo(0.01, 6);
    });

    it("separates scope types that share an id", async () => {
      await store.increment(scope({ scopeType: "group", scopeId: "x" }), 0.05, 1);
      await store.increment(scope({ scopeType: "user", scopeId: "x" }), 0.01, 1);
      expect(
        (await store.read(scope({ scopeType: "group", scopeId: "x" }))).usedUsd
      ).toBeCloseTo(0.05, 6);
      expect(
        (await store.read(scope({ scopeType: "user", scopeId: "x" }))).usedUsd
      ).toBeCloseTo(0.01, 6);
    });

    it("separates by period, so a day rolls the counter", async () => {
      await store.increment(scope({ period: "2026-07-29" }), 0.09, 1);
      expect((await store.read(scope({ period: "2026-07-30" }))).usedUsd).toBe(0);
      expect((await store.read(scope({ period: "2026-07-29" }))).usedUsd).toBeCloseTo(
        0.09,
        6
      );
    });

    it("handles platform scope with no scopeId", async () => {
      const platform = scope({ scopeType: "platform", scopeId: undefined });
      await store.increment(platform, 0.03, 1);
      expect((await store.read(platform)).usedUsd).toBeCloseTo(0.03, 6);
      // A null scope_id must not collide with a scoped row.
      expect((await store.read(scope())).usedUsd).toBe(0);
    });
  });

  describe("reset", () => {
    it("clears accumulated usage", async () => {
      await store.increment(scope(), 0.05, 1);
      await store.reset();
      expect((await store.read(scope())).usedUsd).toBe(0);
    });
  });
}
