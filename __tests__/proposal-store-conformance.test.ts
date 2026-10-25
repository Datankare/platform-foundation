/**
 * __tests__/proposal-store-conformance.test.ts
 * The ProposalStore kit against the in-memory store, and the tenant isolation kit against its
 * tenant partitions (ADR-053 D6). The Postgres store: __tests__/db/proposal-store.db.test.ts.
 */

import { runProposalStoreContract } from "./contract/proposal-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import { memoryTenant, proposalIsolation } from "./helpers/store-isolation-fixtures";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";

describe("InMemoryProposalStore — conformance", () => {
  runProposalStoreContract({
    makeStore: () => new InMemoryProposalStore(),
    // As the approval-expiry job would: the claim's lease has passed (review 11 H-1).
    markUndecided: async (store) => {
      (store as InMemoryProposalStore).recoverStaleRuns(Date.now() + 1);
    },
  });
});

describe("InMemoryProposalStore — tenants", () => {
  runTenantIsolationContract({
    name: "proposals (memory)",
    makeStore: () => new InMemoryProposalStore(),
    createTenant: memoryTenant,
    ...proposalIsolation(),
    failsClosedWithoutTenant: false,
  });

  it("allows one live proposal per operation in each tenant", async () => {
    const store = new InMemoryProposalStore();
    const fx = proposalIsolation();
    const a = await memoryTenant();
    const b = await memoryTenant();
    await a.run(() => fx.write(store, "op"));
    await expect(a.run(() => fx.write(store, "op"))).rejects.toThrow(/already has/);
    await expect(b.run(() => fx.write(store, "op"))).resolves.toBeUndefined();
    store.clear();
    expect(await a.run(() => fx.read(store, "op"))).toBeNull();
  });
});
