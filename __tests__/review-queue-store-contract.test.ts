/**
 * ReviewQueueStore conformance (ADR-027) — in-memory reference arm. The Supabase store's REST
 * calls are covered by platform/moderation/__tests__/review-store-supabase.test.ts.
 */
import { InMemoryReviewQueueStore } from "@/platform/moderation/review-store";
import { runReviewQueueStoreContract } from "./contract/review-queue-store-contract";

describe("ReviewQueueStore contract — in-memory store", () => {
  runReviewQueueStoreContract({ makeStore: () => new InMemoryReviewQueueStore() });
});
