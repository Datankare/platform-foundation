/**
 * @jest-environment node
 */
/**
 * JobStore conformance (ADR-027, ADR-056 D2): the in-memory store. The Postgres store runs the
 * same kit against the replayed database in __tests__/db/jobs.db.test.ts.
 */
import { runJobStoreContract } from "./contract/job-store-contract";
import { InMemoryJobStore } from "@/platform/jobs";
import { runWithTenant } from "@/platform/tenancy/context";
import { getTenantDirectory } from "@/platform/tenancy/directory";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const tenant = (id: string) => ({
  id,
  run: <T>(fn: () => T) => runWithTenant({ tenantId: id, mode: "shared" }, fn),
});

describe("InMemoryJobStore", () => {
  runJobStoreContract({
    makeStore: () => new InMemoryJobStore({ activeTenants: async () => [A, B] }),
    tenants: () => ({ a: tenant(A), b: tenant(B) }),
  });

  it("asks the tenant directory which tenants are active by default", async () => {
    const store = new InMemoryJobStore();
    const fromDirectory = (await getTenantDirectory().listTenants())
      .filter((t) => t.status === "active")
      .map((t) => t.id);
    expect(await store.activeTenantIds()).toEqual(fromDirectory);
  });

  it("shows no tenant history outside a tenant", async () => {
    const store = new InMemoryJobStore({ activeTenants: async () => [A] });
    await store.enqueue({
      tenantId: A,
      kind: "kit.x",
      idempotencyKey: "k",
      maxAttempts: 1,
      source: "enqueue",
    });
    expect(await store.listTenantJobs()).toEqual([]);
  });
});
