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
jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn(async () => {}),
}));

import { getConfig } from "@/platform/auth/platform-config";
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
beforeEach(() => {
  store = new InMemoryReviewQueueStore();
  setReviewQueueStore(store);
  mockGetConfig.mockImplementation(async (_key: string, dflt: unknown) => dflt);
  jest.clearAllMocks();
  mockGetConfig.mockImplementation(async (_key: string, dflt: unknown) => dflt);
});

async function submit(source: ReviewItemSource = "escalation", user = "u1") {
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
