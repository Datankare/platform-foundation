/**
 * __tests__/trajectory-store-conformance.test.ts
 * Runs the TrajectoryStore conformance kit against the in-memory implementation, and the
 * tenant isolation kit against its tenant partitions (ADR-053 D6). The Postgres store runs
 * both in __tests__/db/trajectory-store.db.test.ts.
 */

import { runTrajectoryStoreContract } from "./contract/trajectory-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import { memoryTenant, trajectoryIsolation } from "./helpers/store-isolation-fixtures";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";

describe("InMemoryTrajectoryStore — conformance", () => {
  runTrajectoryStoreContract({
    makeStore: () => new InMemoryTrajectoryStore(),
  });
});

describe("InMemoryTrajectoryStore — tenants", () => {
  runTenantIsolationContract({
    name: "trajectories (memory)",
    makeStore: () => new InMemoryTrajectoryStore(),
    createTenant: memoryTenant,
    ...trajectoryIsolation(),
    failsClosedWithoutTenant: false,
  });

  it("counts and clears per store, across tenants", async () => {
    const store = new InMemoryTrajectoryStore();
    const a = await memoryTenant();
    const b = await memoryTenant();
    await a.run(() => store.create({ kind: "agent", id: "x" }, "t", "platform"));
    expect(a.run(() => store.getRecordCount())).toBe(1);
    expect(b.run(() => store.getRecordCount())).toBe(0);
    store.clear();
    expect(a.run(() => store.getRecordCount())).toBe(0);
  });
});
