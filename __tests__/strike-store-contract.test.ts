/**
 * StrikeStore conformance (ADR-027) — the in-memory reference arm, and its tenant partitions
 * (ADR-053 D8). The Postgres arm is __tests__/db/strike-store.db.test.ts.
 */
import { InMemoryStrikeStore } from "@/platform/moderation/strikes";
import { runStrikeStoreContract } from "./contract/strike-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import {
  memoryTenant,
  memoryUser,
  strikeIsolation,
} from "./helpers/moderation-isolation-fixtures";

describe("StrikeStore contract — in-memory store", () => {
  runStrikeStoreContract({ makeStore: () => new InMemoryStrikeStore() });

  runTenantIsolationContract({
    name: "memory strikes",
    makeStore: () => new InMemoryStrikeStore(),
    createTenant: memoryTenant,
    ...strikeIsolation(memoryUser),
    failsClosedWithoutTenant: false,
  });
});
