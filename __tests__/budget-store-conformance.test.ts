/**
 * __tests__/budget-store-conformance.test.ts
 * Runs the BudgetStore conformance kit against the in-memory implementation.
 */

import { runBudgetStoreContract } from "./contract/budget-store-contract";
import { InMemoryBudgetStore } from "@/platform/agents/budget-tracker";

describe("InMemoryBudgetStore — conformance", () => {
  runBudgetStoreContract({
    makeStore: () => new InMemoryBudgetStore(),
  });
});
