/**
 * ReviewQueueStore conformance (ADR-027) — in-memory reference arm, and its tenant partitions
 * (ADR-053 D8). The Postgres arm is __tests__/db/review-queue-store.db.test.ts.
 */
import { InMemoryReviewQueueStore } from "@/platform/moderation/review-store";
import { runReviewQueueStoreContract } from "./contract/review-queue-store-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import {
  memoryTenant,
  memoryUser,
  reviewQueueIsolation,
} from "./helpers/moderation-isolation-fixtures";

describe("ReviewQueueStore contract — in-memory store", () => {
  runReviewQueueStoreContract({ makeStore: () => new InMemoryReviewQueueStore() });

  runTenantIsolationContract({
    name: "memory review queue",
    makeStore: () => new InMemoryReviewQueueStore(),
    createTenant: memoryTenant,
    ...reviewQueueIsolation(memoryUser),
    failsClosedWithoutTenant: false,
  });
});
