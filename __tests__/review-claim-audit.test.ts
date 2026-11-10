/**
 * __tests__/review-claim-audit.test.ts — taking and releasing a moderation case are recorded
 * (N-37, TASK-203)
 *
 * A reviewer claiming another account's case, or releasing it, is a staff action on that account;
 * the row keeps only the current claimer, overwritten by the next. Each is now recorded before it
 * changes anything (audited(): `review_claimed` / `review_unclaimed`, the case and the account it
 * concerns; a failure adds its outcome), and with no record nothing changes. A refused claim (not pending,
 * one's own case) is refused before any record.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

import { fakeData } from "./helpers/fake-data";
import {
  InMemoryReviewQueueStore,
  setReviewQueueStore,
} from "@/platform/moderation/review-store";
import {
  claimItem,
  submitForReview,
  unclaimItem,
} from "@/platform/moderation/review-service";
import { runWithTenant } from "@/platform/tenancy/context";
import type { ModerationResult } from "@/platform/moderation/types";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-9000-0000000000a1";
const REVIEWER = "00000000-0000-4000-9000-0000000000b1";
const OTHER = "00000000-0000-4000-9000-0000000000b2";
const inTenant = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: TENANT, mode: "single" }, fn);

const RESULT = {
  action: "block",
  reasoning: "r",
  trajectoryId: "t",
  contextFactors: [],
  blocklistMatches: [],
} as unknown as ModerationResult;

let store: InMemoryReviewQueueStore;
beforeEach(() => {
  fakeData().reset();
  store = new InMemoryReviewQueueStore();
  setReviewQueueStore(store);
});

const enqueue = async () => {
  const r = await inTenant(() =>
    submitForReview({
      source: "escalation",
      moderationResult: RESULT,
      targetUserId: ACCOUNT,
      requestId: "req-1",
    })
  );
  return r.item!.id;
};
const records = () =>
  fakeData()
    .audit.filter((a) => /^review_(?:un)?claimed$/.test(a.details.type))
    .map((a) => [
      a.details.type,
      a.details.outcome,
      a.actor_id,
      a.target_id,
      a.details.reviewItemId,
    ]);

describe("claim and unclaim are recorded (N-37)", () => {
  it("a claim is recorded before it changes the case, then its outcome", async () => {
    const id = await enqueue();
    expect(await inTenant(() => claimItem(id, REVIEWER))).toMatchObject({
      success: true,
    });
    // audited(): the attempt is recorded first; a failure would add its outcome (none here).
    expect(records()).toEqual([["review_claimed", "attempted", REVIEWER, ACCOUNT, id]]);
  });

  it("a release is recorded the same way", async () => {
    const id = await enqueue();
    await inTenant(() => claimItem(id, REVIEWER));
    fakeData().audit.length = 0;
    expect(await inTenant(() => unclaimItem(id, REVIEWER))).toMatchObject({
      success: true,
    });
    expect(records()).toEqual([["review_unclaimed", "attempted", REVIEWER, ACCOUNT, id]]);
  });

  it("[hostile:store-down] no record, no change: the audit log down leaves the case pending, 503 coded", async () => {
    const id = await enqueue();
    fakeData().failAudit = true;
    const r = await inTenant(() => claimItem(id, REVIEWER));
    expect(r).toMatchObject({
      success: false,
      errorCode: "service.unavailable",
      errorParams: { service: "audit" },
    });
    expect((await inTenant(() => store.getById(id)))?.status).toBe("pending");
  });

  it("[hostile:role] another reviewer's release is refused before any record", async () => {
    const id = await enqueue();
    await inTenant(() => claimItem(id, REVIEWER));
    fakeData().audit.length = 0;
    expect(await inTenant(() => unclaimItem(id, OTHER))).toMatchObject({
      success: false,
      errorCode: "moderation.not_claimer",
    });
    expect(records()).toEqual([]);
  });

  it("[hostile:self] one's own case is refused before any record", async () => {
    const id = await enqueue();
    expect(await inTenant(() => claimItem(id, ACCOUNT))).toMatchObject({
      success: false,
    });
    expect(records()).toEqual([]);
  });
});
