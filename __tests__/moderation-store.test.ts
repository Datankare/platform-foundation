/**
 * ModerationStore interface contract — reference arm (ADR-027), and the in-memory store's
 * tenant partitions (ADR-053 D8). The Postgres arm is __tests__/db/moderation-store.db.test.ts.
 */
import { runModerationStoreContract } from "./contract/moderation-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import {
  memoryTenant,
  moderationAuditIsolation,
} from "./helpers/moderation-isolation-fixtures";
import { InMemoryModerationStore } from "@/platform/moderation/store";

describe("ModerationStore contract — in-memory store", () => {
  runModerationStoreContract({
    makeStore: () => new InMemoryModerationStore(),
  });

  runTenantIsolationContract({
    name: "memory moderation audits",
    makeStore: () => new InMemoryModerationStore(),
    createTenant: memoryTenant,
    ...moderationAuditIsolation(),
    failsClosedWithoutTenant: false,
  });
});
