/**
 * __tests__/contract/strike-store-contract.ts — StrikeStore conformance kit (ADR-027)
 *
 * Every StrikeStore (in-memory reference, Supabase) must behave the same: a strike past its
 * expiry no longer counts, whether or not the expiry sweep has run (no timed job runs it —
 * TASK-141); one user's strikes never count for another; expireStrike is idempotent.
 * Registry slot "strikeStore" (Sprint 7X, audit X-3). Not a *.test.ts.
 */

import type { StrikeRecord, StrikeStore } from "@/platform/moderation/types";

export interface StrikeStoreContractFixtures {
  makeStore: () => StrikeStore | Promise<StrikeStore>;
}

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
const DAY = 86_400_000;

function strike(
  overrides: Partial<StrikeRecord> = {}
): Omit<StrikeRecord, "id" | "createdAt"> {
  return {
    userId: A,
    category: "harassment",
    severity: "medium",
    moderationAuditId: null,
    guardianDecisionId: "guardian-1",
    trajectoryId: "sentinel-1",
    agentId: "sentinel",
    reason: "contract",
    expiresAt: new Date(Date.now() + DAY).toISOString(),
    expired: false,
    ...overrides,
  };
}

export function runStrikeStoreContract(fx: StrikeStoreContractFixtures): void {
  let store: StrikeStore;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  it("records a strike and returns it with an id", async () => {
    const res = await store.recordStrike(strike());
    expect(res.success).toBe(true);
    expect(res.record?.id).toBeTruthy();
    expect(res.record?.userId).toBe(A);
  });

  it("counts only the user's own active strikes", async () => {
    await store.recordStrike(strike());
    await store.recordStrike(strike({ userId: B }));
    expect(await store.getActiveStrikes(A)).toHaveLength(1);
    expect((await store.getStrikeSummary(A)).totalActive).toBe(1);
    expect((await store.getStrikeSummary(B)).totalActive).toBe(1);
  });

  it("does not count a strike past its expiry, even before any sweep runs", async () => {
    await store.recordStrike(
      strike({ expiresAt: new Date(Date.now() - DAY).toISOString() })
    );
    await store.recordStrike(strike({ expiresAt: null }));
    expect(await store.getActiveStrikes(A)).toHaveLength(1);
    expect((await store.getStrikeSummary(A)).totalActive).toBe(1);
  });

  it("summarises by category and highest severity", async () => {
    await store.recordStrike(strike({ category: "spam", severity: "low" }));
    await store.recordStrike(strike({ category: "harassment", severity: "high" }));
    const summary = await store.getStrikeSummary(A);
    expect(summary.byCategory).toEqual({ spam: 1, harassment: 1 });
    expect(summary.highestSeverity).toBe("high");
  });

  it("expires one strike by id, once", async () => {
    const res = await store.recordStrike(strike());
    expect(await store.expireStrike(res.record!.id)).toBe(true);
    expect(await store.expireStrike(res.record!.id)).toBe(false);
    expect(await store.getActiveStrikes(A)).toHaveLength(0);
  });

  it("queries a user's strikes by category", async () => {
    await store.recordStrike(strike({ category: "spam" }));
    await store.recordStrike(strike({ category: "harassment" }));
    const spam = await store.queryStrikes({ userId: A, category: "spam" });
    expect(spam.map((s) => s.category)).toEqual(["spam"]);
  });
}
