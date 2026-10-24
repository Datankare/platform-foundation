/**
 * embedding-store-conformance.test.ts — ADR-042 L21: the one no-leak kit, run against the
 * in-memory reference store here and against PostgresEmbeddingStore on the real database in
 * __tests__/db/embedding-store.db.test.ts; an adopter store runs the same kit. The tenant
 * isolation kit runs against the in-memory store's tenant partitions (ADR-053 D6).
 */
import { runEmbeddingStoreContract } from "./contract/embedding-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import { embeddingIsolation, memoryTenant } from "./helpers/store-isolation-fixtures";
import { InMemoryEmbeddingStore } from "@/platform/rag";

runEmbeddingStoreContract({
  name: "InMemoryEmbeddingStore",
  makeStore: () => new InMemoryEmbeddingStore(),
});

describe("InMemoryEmbeddingStore — tenants", () => {
  runTenantIsolationContract({
    name: "embeddings (memory)",
    makeStore: () => new InMemoryEmbeddingStore(),
    createTenant: memoryTenant,
    ...embeddingIsolation(),
    failsClosedWithoutTenant: false,
  });

  it("counts only the current tenant's vectors", async () => {
    const store = new InMemoryEmbeddingStore();
    const fx = embeddingIsolation();
    const a = await memoryTenant();
    const b = await memoryTenant();
    await a.run(() => fx.write(store, "k1"));
    await a.run(() => fx.write(store, "k2"));
    expect(await a.run(() => store.count())).toBe(2);
    expect(await b.run(() => store.count())).toBe(0);
  });
});
