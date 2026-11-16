/**
 * @jest-environment node
 */
/**
 * __tests__/review-queue-page.test.ts — a moderator's read of the queue that fails is said, never
 * shown as an empty queue (TASK-221, SF-admin-149)
 *
 * The review store's `query` answers an empty list when it cannot read (P11: the moderation
 * pipeline never waits on it). The review screen read the queue through it, so a database outage
 * read as "No items in the review queue". The screen now reads `page`, which throws instead; the
 * route turns that into a refusal the screen says (moderation-review-routes.test.ts).
 */

jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  withTenantTx: jest.fn(async () => {
    throw new Error("review_queue is unavailable");
  }),
}));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { PostgresReviewQueueStore } from "@/platform/moderation/review-store";

describe("the review store's page read (TASK-221)", () => {
  it("throws when the queue cannot be read — the pipeline's query still answers empty (P11)", async () => {
    const store = new PostgresReviewQueueStore();
    await expect(store.query({ status: "pending" })).resolves.toEqual([]);
    await expect(store.page({ status: "pending", limit: 25 })).rejects.toThrow(
      "review_queue is unavailable"
    );
  });
});
