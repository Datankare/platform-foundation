/**
 * SocialStore interface contract — reference arm (ADR-027), and the in-memory store's tenant
 * partitions (ADR-053 D8). The Postgres arm is __tests__/db/social-store.db.test.ts.
 */
import { runSocialStoreContract } from "./contract/social-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import { memoryTenant, memoryUser } from "./helpers/moderation-isolation-fixtures";
import { socialIsolation } from "./helpers/social-isolation-fixtures";
import { InMemorySocialStore } from "@/platform/social/memory-social-store";

describe("SocialStore contract — in-memory store", () => {
  runSocialStoreContract({
    makeStore: () => new InMemorySocialStore(),
  });

  runTenantIsolationContract({
    name: "memory social groups",
    makeStore: () => new InMemorySocialStore(),
    createTenant: memoryTenant,
    ...socialIsolation(memoryUser),
    failsClosedWithoutTenant: false,
  });
});
