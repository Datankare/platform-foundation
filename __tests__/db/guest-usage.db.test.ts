/**
 * @jest-environment node
 */
/**
 * PostgresGuestUsageStore against the replayed database: the conformance kit inside one tenant
 * (each test a fresh tenant, so a fresh store), the store isolated between tenants, and the
 * consume function's own checks.
 */

import { createHash } from "node:crypto";
import { runGuestUsageStoreContract } from "../contract/guest-usage-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { PostgresGuestUsageStore } from "@/platform/auth/guest-allowance";
import { newGuestId } from "@/platform/auth/guest-token";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
} from "../helpers/db";

/** The kit's keys are free text; a guest id is `guest_` + 32 of [a-z0-9]. */
const guestFor = (key: string) =>
  "guest_" + createHash("sha256").update(key).digest("hex").slice(0, 32);

dbDescribe("PostgresGuestUsageStore", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runGuestUsageStoreContract({
    makeStore: async () =>
      inTenant(new PostgresGuestUsageStore(), await createTestTenant()),
  });

  runTenantIsolationContract({
    name: "guest usage",
    makeStore: () => new PostgresGuestUsageStore(),
    createTenant: createTestTenant,
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
  });

  it("refuses an invalid guest id or limit (the function's checks)", async () => {
    const t = await createTestTenant();
    const store = new PostgresGuestUsageStore();
    await expect(t.run(() => store.consume("guest_x", 5))).rejects.toThrow(
      /invalid guest id/
    );
    await expect(t.run(() => store.consume(newGuestId(), 0))).rejects.toThrow(
      /invalid limit/
    );
  });
});
