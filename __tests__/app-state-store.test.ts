/**
 * __tests__/app-state-store.test.ts
 * Runs the ActivityStateStore conformance kit against the in-memory implementation, and the
 * tenant isolation kit against its tenant partitions (ADR-053 D6). The Postgres store runs
 * both in __tests__/db/app-state-store.db.test.ts.
 */

import { runAppStateStoreContract } from "./contract/app-state-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import { appStateIsolation, memoryTenant } from "./helpers/store-isolation-fixtures";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";

describe("InMemoryActivityStateStore — conformance", () => {
  runAppStateStoreContract({
    makeStore: () => new InMemoryActivityStateStore(),
  });
});

describe("InMemoryActivityStateStore — tenants", () => {
  runTenantIsolationContract({
    name: "app sessions (memory)",
    makeStore: () => new InMemoryActivityStateStore<{ n: number }>(),
    createTenant: memoryTenant,
    ...appStateIsolation(),
    failsClosedWithoutTenant: false,
  });

  it("keeps session meta per tenant", async () => {
    const store = new InMemoryActivityStateStore<{ n: number }>();
    const meta = { participants: [] } as unknown as Parameters<typeof store.saveMeta>[1];
    const a = await memoryTenant();
    const b = await memoryTenant();
    await a.run(() => store.create("s", { n: 1 }));
    await a.run(() => store.saveMeta("s", meta));
    expect(await b.run(() => store.loadMeta("s"))).toBeNull();
    await expect(b.run(() => store.saveMeta("s", meta))).rejects.toThrow("not found");
    expect(await a.run(() => store.loadMeta("s"))).toEqual(meta);
  });
});
