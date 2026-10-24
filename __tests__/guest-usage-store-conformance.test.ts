/**
 * GuestUsageStore conformance (ADR-027): the memory store, inside a tenant and isolated between
 * tenants (ADR-053 D8). The Postgres store runs the same kit against the database in
 * __tests__/db/guest-usage.db.test.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { runGuestUsageStoreContract } from "./contract/guest-usage-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import { MemoryGuestUsageStore } from "@/platform/auth/guest-allowance";
import { runWithTenant } from "@/platform/tenancy/context";

/** The kit's keys are free text; a guest id is `guest_` + 32 of [a-z0-9]. */
const guestFor = (key: string) =>
  "guest_" + createHash("sha256").update(key).digest("hex").slice(0, 32);

const memoryTenant = async () => {
  const ctx = { tenantId: randomUUID(), mode: "shared" as const };
  return { run: <T>(fn: () => T) => runWithTenant(ctx, fn) };
};

describe("MemoryGuestUsageStore — conformance", () => {
  runGuestUsageStoreContract({ makeStore: () => new MemoryGuestUsageStore() });
});

describe("MemoryGuestUsageStore — tenants", () => {
  runTenantIsolationContract({
    name: "guest usage (memory)",
    makeStore: () => new MemoryGuestUsageStore(),
    createTenant: memoryTenant,
    write: async (store, key) => {
      await store.consume(guestFor(key), 5);
    },
    read: async (store, key) => {
      const used = await store.used(guestFor(key));
      return used > 0 ? used : null;
    },
    update: async (store, key) => {
      await store.consume(guestFor(key), 5);
    },
    remove: (store) => store.reset(),
    failsClosedWithoutTenant: false,
  });
});
