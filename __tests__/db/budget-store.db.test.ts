/**
 * @jest-environment node
 */
/**
 * PostgresBudgetStore against the replayed database: the conformance kit inside one tenant
 * (each test a fresh tenant, so a fresh store), and the store isolated between tenants.
 */

import { runBudgetStoreContract } from "../contract/budget-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { PostgresBudgetStore } from "@/platform/agents/postgres-budget-store";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
} from "../helpers/db";

dbDescribe("PostgresBudgetStore", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runBudgetStoreContract({
    makeStore: async () => inTenant(new PostgresBudgetStore(), await createTestTenant()),
  });

  runTenantIsolationContract({
    name: "budgets",
    makeStore: () => new PostgresBudgetStore(),
    createTenant: createTestTenant,
    write: async (store, key) => {
      await store.increment(
        { agentId: key, scopeType: "platform", period: "2026-10-23" },
        1,
        1
      );
    },
    read: async (store, key) => {
      const u = await store.read({
        agentId: key,
        scopeType: "platform",
        period: "2026-10-23",
      });
      return u.usedSteps > 0 ? u : null;
    },
    remove: async (store) => store.reset(),
  });
});
