/**
 * __tests__/budget-tracker-singleton.test.ts
 *
 * Registry slot #16's wiring. setBudgetTracker is what the provider registry calls, and
 * nothing proved it takes effect — the same gap slots #17 and #18 had, and the same shape
 * as SupabaseActivityStateStore, which shipped dead because no test reached it (TASK-066).
 */

import {
  BudgetTracker,
  InMemoryBudgetStore,
  getBudgetTracker,
  setBudgetTracker,
  resetBudgetTracker,
} from "@/platform/agents/budget-tracker";

describe("budget tracker singleton (registry slot #16)", () => {
  afterEach(() => {
    resetBudgetTracker();
  });

  it("defaults to a tracker over an in-memory store", () => {
    expect(getBudgetTracker()).toBeInstanceOf(BudgetTracker);
  });

  it("setBudgetTracker takes effect and returns the previous tracker", async () => {
    const first = getBudgetTracker();
    const store = new InMemoryBudgetStore();
    const replacement = new BudgetTracker(store);

    const previous = setBudgetTracker(replacement);

    expect(previous).toBe(first);
    expect(getBudgetTracker()).toBe(replacement);

    // Prove it is the ACTIVE tracker, not merely the returned one.
    await getBudgetTracker().consume("guardian", "platform", undefined, 0.02);
    const direct = await store.read({
      agentId: "guardian",
      scopeType: "platform",
      scopeId: undefined,
      period: replacement.getCurrentPeriod(),
    });
    expect(direct.usedUsd).toBeCloseTo(0.02, 6);
  });

  it("resetBudgetTracker installs a fresh tracker with no accumulated spend", async () => {
    await getBudgetTracker().consume("guardian", "platform", undefined, 0.05);
    expect(
      (await getBudgetTracker().getStatus("guardian", "platform", undefined)).usedUsd
    ).toBeCloseTo(0.05, 6);

    resetBudgetTracker();

    expect(
      (await getBudgetTracker().getStatus("guardian", "platform", undefined)).usedUsd
    ).toBe(0);
  });
});
