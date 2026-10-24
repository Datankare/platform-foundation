/**
 * __tests__/contract/review-queue-store-contract.ts — ReviewQueueStore conformance kit (ADR-027)
 *
 * Registry slot "reviewQueueStore" (Sprint 7X, audit X-3). Every store keeps a submitted item
 * until it is resolved, finds an open appeal by its decision, filters by status, source and
 * target, and releases only claims older than the timeout. Not a *.test.ts.
 */

import type {
  ReviewQueueItem,
  ReviewQueueStore,
} from "@/platform/moderation/review-types";

export interface ReviewQueueStoreContractFixtures {
  makeStore: () => ReviewQueueStore | Promise<ReviewQueueStore>;
  /**
   * The two users the kit's items are about, read after each makeStore. A store whose items
   * must name real users (a foreign key) creates them there; default: two fixed ids.
   */
  users?: () => { readonly a: string; readonly b: string };
}

const DEFAULT_USERS = {
  a: "00000000-0000-4000-8000-0000000000a1",
  b: "00000000-0000-4000-8000-0000000000b1",
};

function item(
  A: string,
  overrides: Partial<ReviewQueueItem> = {}
): Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt"> {
  return {
    source: "escalation",
    priority: "high",
    status: "pending",
    moderationResult: {
      action: "escalate",
      triggeredBy: "classifier",
      direction: "input",
      contentType: "generation",
      contentRatingLevel: 1,
      blocklistMatches: [],
      reasoning: "contract",
      severityAdjustment: 0,
      contextFactors: [],
      attributeToUser: true,
      pipelineLatencyMs: 1,
      classifierCostUsd: 0,
      trajectoryId: "guardian-1",
      agentId: "guardian",
    },
    targetUserId: A,
    requestId: "req-1",
    ...overrides,
  } as Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">;
}

export function runReviewQueueStoreContract(fx: ReviewQueueStoreContractFixtures): void {
  let store: ReviewQueueStore;
  let A: string;
  let B: string;

  beforeEach(async () => {
    store = await fx.makeStore();
    ({ a: A, b: B } = fx.users?.() ?? DEFAULT_USERS);
  });

  it("submits an item and reads it back by id", async () => {
    const res = await store.submit(item(A));
    expect(res.success).toBe(true);
    const read = await store.getById(res.item!.id);
    expect(read).toMatchObject({
      targetUserId: A,
      status: "pending",
      source: "escalation",
    });
  });

  it("returns nothing for an unknown id", async () => {
    await expect(
      store.getById("00000000-0000-4000-8000-000000000000")
    ).resolves.toBeUndefined();
  });

  it("updates status and claim fields", async () => {
    const { item: created } = await store.submit(item(A));
    const claimedAt = new Date().toISOString();
    const res = await store.update(created!.id, {
      status: "claimed",
      claimedBy: B,
      claimedAt,
    });
    expect(res.success).toBe(true);
    expect(await store.getById(created!.id)).toMatchObject({
      status: "claimed",
      claimedBy: B,
    });
  });

  it("clears a claim with null, and leaves fields out of an update unchanged", async () => {
    const { item: created } = await store.submit(item(A));
    await store.update(created!.id, {
      status: "claimed",
      claimedBy: B,
      claimedAt: new Date().toISOString(),
    });
    await store.update(created!.id, { priority: "critical" });
    expect(await store.getById(created!.id)).toMatchObject({
      status: "claimed",
      claimedBy: B,
      priority: "critical",
    });
    const res = await store.update(created!.id, {
      status: "pending",
      claimedBy: null,
      claimedAt: null,
    });
    expect(res.success).toBe(true);
    const read = await store.getById(created!.id);
    expect(read?.status).toBe("pending");
    expect(read?.claimedBy).toBeUndefined();
    expect(read?.claimedAt).toBeUndefined();
  });

  it("updates with an expected state only while the item is in it (compare-and-set)", async () => {
    const { item: created } = await store.submit(item(A));
    const claim = (by: string) =>
      store.update(
        created!.id,
        { status: "claimed", claimedBy: by, claimedAt: new Date().toISOString() },
        { status: "pending" }
      );
    const [first, second] = await Promise.all([claim(B), claim(A)]);
    expect([first.success, second.success].sort()).toEqual([false, true]);
    const loser = first.success ? second : first;
    expect(loser.errorCode).toBe("moderation.item_state_conflict");
    const winner = (await store.getById(created!.id))!.claimedBy!;
    // Only the claimer, while it still holds the claim, can resolve.
    const other = winner === A ? B : A;
    const wrong = await store.update(
      created!.id,
      { status: "resolved", decision: "uphold" },
      { status: "claimed", claimedBy: other }
    );
    expect(wrong.errorCode).toBe("moderation.item_state_conflict");
    const right = await store.update(
      created!.id,
      { status: "resolved", decision: "uphold" },
      { status: "claimed", claimedBy: winner }
    );
    expect(right.success).toBe(true);
    const missing = await store.update(
      "00000000-0000-4000-8000-000000000000",
      { status: "resolved" },
      { status: "claimed" }
    );
    expect(missing.errorCode).toBe("moderation.review_item_not_found");
  });

  it("filters by status, source and target", async () => {
    await store.submit(item(A));
    await store.submit(
      item(A, { source: "appeal", priority: "normal", targetUserId: B })
    );
    expect(await store.query({ source: "appeal" })).toHaveLength(1);
    expect(await store.query({ targetUserId: A })).toHaveLength(1);
    expect(await store.query({ status: "resolved" })).toHaveLength(0);
  });

  it("finds an open appeal by its decision, and not once resolved", async () => {
    const { item: appeal } = await store.submit(
      item(A, { source: "appeal", priority: "normal", originalDecisionId: "decision-1" })
    );
    expect((await store.getByOriginalDecisionId("decision-1"))?.id).toBe(appeal!.id);
    await store.update(appeal!.id, { status: "resolved" });
    expect(await store.getByOriginalDecisionId("decision-1")).toBeUndefined();
  });

  it("counts pending items in its stats", async () => {
    await store.submit(item(A));
    await store.submit(item(A, { source: "ban_review", priority: "critical" }));
    const stats = await store.getStats();
    expect(stats.pendingCount).toBe(2);
    expect(stats.pendingBySource.ban_review).toBe(1);
  });

  it("releases only claims older than the timeout", async () => {
    const { item: old } = await store.submit(item(A));
    const { item: fresh } = await store.submit(item(A));
    await store.update(old!.id, {
      status: "claimed",
      claimedBy: B,
      claimedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    await store.update(fresh!.id, {
      status: "claimed",
      claimedBy: B,
      claimedAt: new Date().toISOString(),
    });
    expect(await store.releaseExpiredClaims(3_600_000)).toBe(1);
    expect((await store.getById(old!.id))?.status).toBe("pending");
    expect((await store.getById(fresh!.id))?.status).toBe("claimed");
  });
}
