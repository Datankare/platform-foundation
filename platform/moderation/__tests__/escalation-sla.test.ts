/**
 * platform/moderation/__tests__/escalation-sla.test.ts
 *
 * ADR-041 conformance kit (L21) — the escalation SLA reaper. Deep imports (no
 * barrel) exercise the mechanism directly. getConfig is mocked to return the
 * caller's fallback, so the SLA resolves to the fail-closed default; we reap with
 * a `now` far past any [min,max] guardrail, so items are overdue under any SLA.
 */
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (_key: string, dflt: unknown) => dflt),
}));
// The real audit module, writing to an in-memory database: each reaper change is recorded first.
jest.mock("@/platform/data", () =>
  require("@/__tests__/helpers/fake-account-data").fakeAccountData(() => mockDb)
);

import { getConfig } from "@/platform/auth/platform-config";
import { FakeDatabase } from "@/__tests__/helpers/fake-database";
import { InMemoryReviewQueueStore, setReviewQueueStore } from "../review-store";
import { submitForReview, reapOverdueEscalations } from "../review-service";
import type { ModerationResult } from "../types";
import type { ReviewItemSource } from "../review-types";

const mockGetConfig = getConfig as jest.Mock;

function makeModerationResult(
  overrides: Partial<ModerationResult> = {}
): ModerationResult {
  return {
    action: "escalate",
    triggeredBy: "content-rating",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    reasoning: "Low confidence — escalating.",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 250,
    classifierCostUsd: 0.001,
    trajectoryId: "traj-1",
    agentId: "guardian-1",
    ...overrides,
  };
}

let store: InMemoryReviewQueueStore;
let db: FakeDatabase;
let mockDb: FakeDatabase;
beforeEach(() => {
  db = mockDb = new FakeDatabase({ audit_log: [] });
  store = new InMemoryReviewQueueStore();
  setReviewQueueStore(store);
  mockGetConfig.mockImplementation(async (_key: string, dflt: unknown) => dflt);
  jest.clearAllMocks();
  mockGetConfig.mockImplementation(async (_key: string, dflt: unknown) => dflt);
});

/** A distinct user id per name, as the audit log requires real ids. */
const uid = (name: string) =>
  `00000000-0000-4000-8000-${Buffer.from(name).toString("hex").padStart(12, "0").slice(-12)}`;

async function submit(source: ReviewItemSource = "escalation", name = "u1") {
  const user = uid(name);
  return submitForReview({
    source,
    moderationResult: makeModerationResult(),
    targetUserId: user,
    requestId: `req-${user}`,
  });
}

// Far past any [min,max] guardrail (max is 168h) → overdue under any resolved SLA.
const WAY_LATER = new Date(Date.now() + 10_000 * 3_600_000);

describe("ADR-041 escalation SLA reaper — block (secure default)", () => {
  it("blocks an over-SLA pending escalation; the outcome is never allow", async () => {
    await submit();
    const res = await reapOverdueEscalations(WAY_LATER);
    expect(res.blocked).toBe(1);
    const items = await store.query({});
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("resolved");
    expect(items[0].decision).toBe("modify");
    expect(items[0].modifiedAction).toBe("block");
    expect(items[0].modifiedAction).not.toBe("allow");
  });

  it("leaves items still within SLA untouched (self-test: reaper can act, doesn't here)", async () => {
    await submit();
    const res = await reapOverdueEscalations(new Date());
    expect(res.blocked).toBe(0);
    const items = await store.query({});
    expect(items[0].status).toBe("pending");
  });

  it("only reaps escalations — an overdue ban_review is left alone", async () => {
    await submit("ban_review", "b1");
    const res = await reapOverdueEscalations(WAY_LATER);
    expect(res.scanned).toBe(0);
    expect(res.blocked).toBe(0);
    const items = await store.query({});
    expect(items[0].status).toBe("pending");
  });

  it("is idempotent — a second sweep is a no-op (blocked item leaves the overdue set)", async () => {
    await submit();
    const first = await reapOverdueEscalations(WAY_LATER);
    const second = await reapOverdueEscalations(WAY_LATER);
    expect(first.blocked).toBe(1);
    expect(second.scanned).toBe(0);
    expect(second.blocked).toBe(0);
  });
});

describe("ADR-041 escalation SLA reaper — escalate_higher remedial", () => {
  beforeEach(() => {
    mockGetConfig.mockImplementation(async (k: string, dflt: unknown) =>
      k === "moderation.escalation_remedial_action" ? "escalate_higher" : dflt
    );
  });

  it("ratchets an over-SLA escalation to critical and re-queues (no block)", async () => {
    await submit();
    const res = await reapOverdueEscalations(WAY_LATER);
    expect(res.escalatedHigher).toBe(1);
    expect(res.blocked).toBe(0);
    const items = await store.query({});
    expect(items[0].priority).toBe("critical");
    expect(items[0].status).toBe("pending");
  });

  it("is idempotent in effect — already-critical items are skipped on re-sweep", async () => {
    await submit();
    await reapOverdueEscalations(WAY_LATER);
    const second = await reapOverdueEscalations(WAY_LATER);
    expect(second.escalatedHigher).toBe(0);
    const items = await store.query({});
    expect(items[0].priority).toBe("critical");
  });
});

describe("ADR-041 reaper — recorded first (audit X-8)", () => {
  it("records each block under the reaper's name before making it", async () => {
    await submit();
    await reapOverdueEscalations(WAY_LATER);
    expect(db.rows("audit_log")[0]).toMatchObject({
      actor_id: null,
      details: expect.objectContaining({
        agent: "escalation-reaper",
        type: "escalation_sla_block",
      }),
    });
  });

  it("leaves an item for the next sweep when its record cannot be written", async () => {
    await submit();
    db.failWrites("audit_log");
    const res = await reapOverdueEscalations(WAY_LATER);
    expect(res.blocked).toBe(0);
    expect((await store.query({}))[0].status).toBe("pending");
  });
});
