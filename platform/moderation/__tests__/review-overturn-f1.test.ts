/**
 * platform/moderation/__tests__/review-overturn-f1.test.ts
 *
 * F1 (Sprint 6 adversarial review — Saboteur): an overturn restores the account to its
 * PRE-DECISION status, not blanket "active"; escalations never touch the users table.
 *
 * X-2 / X-6 / X-8 (Sprint 7X adversarial audit): an overturn only ever LOWERS an account's
 * status, whatever previous status the item claims; a moderator cannot claim or resolve a case
 * about their own account; the resolution is recorded before anything changes, and a failed
 * restoration leaves the item claimed. Runs against an in-memory database with the real audit
 * module (__tests__/helpers/fake-database.ts); the account-status statements reach it through
 * __tests__/helpers/fake-account-data.ts, and are proved against Postgres by
 * __tests__/db/moderation-account-status.db.test.ts.
 *
 * Release review (Sprint 7X): an overturn lifts only the overturned decision's consequence. The
 * account is restored only when the latest recorded status change is this decision's and is in
 * force; overturning a warning never lifts a later ban, whatever the item claims.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest
    .fn()
    .mockImplementation((_key: string, defaultVal: unknown) =>
      Promise.resolve(defaultVal)
    ),
}));

// The audit module's writes and the account-status SQL both land in the same in-memory
// database, so their order is visible.
jest.mock("@/platform/data", () =>
  require("@/__tests__/helpers/fake-account-data").fakeAccountData(() => mockDb)
);

import { FakeDatabase } from "@/__tests__/helpers/fake-database";
import { submitForReview, claimItem, resolveItem } from "../review-service";
import { InMemoryReviewQueueStore, setReviewQueueStore } from "../review-store";
import { InMemoryStrikeStore, setStrikeStore } from "../strikes";
import type { AccountStatus, ModerationResult } from "../types";

const TARGET = "00000000-0000-4000-8000-0000000000f1";
const REVIEWER = "00000000-0000-4000-8000-0000000000e1";
let db: FakeDatabase;
let mockDb: FakeDatabase;

function makeModerationResult(
  overrides: Partial<ModerationResult> = {}
): ModerationResult {
  return {
    action: "block",
    triggeredBy: "classifier",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    reasoning: "Blocked for test.",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 100,
    classifierCostUsd: 0.001,
    trajectoryId: "traj-f1",
    agentId: "guardian-f1",
    ...overrides,
  };
}

interface Change {
  decision: string;
  from: AccountStatus;
  to: AccountStatus;
  at: string;
  outcome?: "attempted" | "failed";
}

/** A Sentinel status-change record, as sentinel.ts writes it. */
const change = (c: Change) => ({
  id: `chg-${c.decision}-${c.at}-${c.outcome ?? "attempted"}`,
  action: "admin_action",
  actor_id: null,
  target_id: TARGET,
  created_at: c.at,
  details: {
    type: "sentinel_status_change",
    agent: "sentinel",
    previousStatus: c.from,
    newStatus: c.to,
    guardianDecisionId: c.decision,
    outcome: c.outcome ?? "attempted",
  },
});

function setup(current: AccountStatus, changes: Change[] = []) {
  db = mockDb = new FakeDatabase({
    users: [
      {
        id: TARGET,
        account_status: current,
        banned_at: current === "banned" ? "2026-10-01" : null,
        suspended_until: "2026-12-01",
        restricted_until: "2026-12-01",
      },
    ],
    audit_log: changes.map(change),
  });
}

/** The account was set to `current` by the decision under review ("traj-f1"), from `from`. */
const setBy = (from: AccountStatus, current: AccountStatus) =>
  setup(current, [
    { decision: "traj-f1", from, to: current, at: "2026-10-01T00:00:00Z" },
  ]);

async function submitAndClaim(opts: {
  source: "escalation" | "ban_review" | "appeal";
  previousAccountStatus?: AccountStatus;
  action?: ModerationResult["action"];
  reviewer?: string;
}) {
  const submitted = await submitForReview({
    source: opts.source,
    moderationResult: makeModerationResult({ action: opts.action ?? "block" }),
    targetUserId: TARGET,
    requestId: "req-f1",
    previousAccountStatus: opts.previousAccountStatus,
  });
  const claimed = await claimItem(submitted.item!.id, opts.reviewer ?? REVIEWER);
  return { id: submitted.item!.id, claimed };
}

const overturn = (id: string, reviewerId = REVIEWER) =>
  resolveItem({
    itemId: id,
    reviewerId,
    decision: "overturn",
    reviewerNotes: "Overturning to exercise restoration.",
  });

const user = () => db.rows("users")[0];

let store: InMemoryReviewQueueStore;

beforeEach(() => {
  store = new InMemoryReviewQueueStore();
  setReviewQueueStore(store);
  setStrikeStore(new InMemoryStrikeStore());
  jest.clearAllMocks();
  setup("banned");
});

describe("F1 — overturn account status restoration", () => {
  it("escalation overturn does NOT touch the users table", async () => {
    const { id } = await submitAndClaim({ source: "escalation", action: "escalate" });
    const res = await overturn(id);
    expect(res.success).toBe(true);
    expect(db.writes.filter(([, table]) => table === "users")).toEqual([]);
  });

  it("restores the status recorded before this decision (warned), not active", async () => {
    setBy("warned", "banned");
    const { id } = await submitAndClaim({ source: "ban_review" });
    const res = await overturn(id);
    expect(res.success).toBe(true);
    expect(user()).toMatchObject({
      account_status: "warned",
      banned_at: null,
      suspended_until: null,
      restricted_until: null,
      status_changed_by: REVIEWER,
    });
  });

  it("trusts the record, not the item's claimed previous status", async () => {
    setBy("warned", "banned");
    const { id } = await submitAndClaim({
      source: "ban_review",
      previousAccountStatus: "active",
    });
    await overturn(id);
    expect(user().account_status).toBe("warned");
  });

  it("leaves the account unchanged when no record shows this decision changed it", async () => {
    const { id } = await submitAndClaim({ source: "ban_review" });
    expect((await overturn(id)).success).toBe(true);
    expect(user().account_status).toBe("banned");
    expect(db.writes.filter(([op, t]) => op === "update" && t === "users")).toEqual([]);
  });

  it("does NOT clear suspended_until when restoring INTO suspended", async () => {
    setBy("suspended", "banned");
    const { id } = await submitAndClaim({ source: "ban_review" });
    await overturn(id);
    expect(user()).toMatchObject({
      account_status: "suspended",
      suspended_until: "2026-12-01",
      restricted_until: null,
    });
  });

  it("does NOT clear restricted_until when restoring INTO restricted", async () => {
    setBy("restricted", "banned");
    const { id } = await submitAndClaim({ source: "ban_review" });
    await overturn(id);
    expect(user()).toMatchObject({
      account_status: "restricted",
      restricted_until: "2026-12-01",
      suspended_until: null,
    });
  });

  it("persists previousAccountStatus on the submitted item", async () => {
    const submitted = await submitForReview({
      source: "ban_review",
      moderationResult: makeModerationResult(),
      targetUserId: TARGET,
      requestId: "req-f1",
      previousAccountStatus: "warned",
    });
    expect(submitted.item!.previousAccountStatus).toBe("warned");
  });
});

describe("X-2 — an overturn never imposes a consequence", () => {
  it.each([
    ["active", "banned"],
    ["warned", "suspended"],
    ["restricted", "restricted"],
  ] as const)(
    "leaves a %s account alone when the item claims the previous status was %s",
    async (current, claimed) => {
      setup(current);
      const { id } = await submitAndClaim({
        source: "ban_review",
        previousAccountStatus: claimed,
      });
      expect((await overturn(id)).success).toBe(true);
      expect(user().account_status).toBe(current);
      expect(
        db.writes.filter(([op, table]) => op === "update" && table === "users")
      ).toEqual([]);
    }
  );

  it("leaves the account alone when even the record names a more severe previous status", async () => {
    setBy("banned", "warned");
    const { id } = await submitAndClaim({ source: "ban_review" });
    await overturn(id);
    expect(user().account_status).toBe("warned");
  });
});

describe("release review — only the overturned decision's consequence is lifted", () => {
  it("overturning an earlier warning does not lift a later ban", async () => {
    setup("banned", [
      { decision: "traj-f1", from: "active", to: "warned", at: "2026-10-01T00:00:00Z" },
      {
        decision: "traj-later",
        from: "warned",
        to: "banned",
        at: "2026-10-05T00:00:00Z",
      },
    ]);
    const { id } = await submitAndClaim({ source: "appeal" });
    expect((await overturn(id)).success).toBe(true);
    expect(user()).toMatchObject({ account_status: "banned", banned_at: "2026-10-01" });
  });

  it("restores when the overturned decision is the latest and still in force", async () => {
    setup("banned", [
      {
        decision: "traj-early",
        from: "active",
        to: "warned",
        at: "2026-10-01T00:00:00Z",
      },
      { decision: "traj-f1", from: "warned", to: "banned", at: "2026-10-05T00:00:00Z" },
    ]);
    const { id } = await submitAndClaim({ source: "appeal" });
    await overturn(id);
    expect(user().account_status).toBe("warned");
  });

  it("ignores a status change whose failure was recorded (it never happened)", async () => {
    setup("warned", [
      {
        decision: "traj-early",
        from: "active",
        to: "warned",
        at: "2026-10-01T00:00:00Z",
      },
      { decision: "traj-f1", from: "warned", to: "banned", at: "2026-10-05T00:00:00Z" },
      {
        decision: "traj-f1",
        from: "warned",
        to: "banned",
        at: "2026-10-05T00:00:01Z",
        outcome: "failed",
      },
    ]);
    const { id } = await submitAndClaim({ source: "appeal" });
    await overturn(id);
    expect(user().account_status).toBe("warned");
    expect(db.writes.filter(([op, t]) => op === "update" && t === "users")).toEqual([]);
  });

  it("changes nothing, and keeps the item claimed, when the status history cannot be read", async () => {
    setBy("warned", "banned");
    const { id } = await submitAndClaim({ source: "ban_review" });
    db.failReads("audit_log");
    const res = await overturn(id);
    expect(res.success).toBe(false);
    expect(user().account_status).toBe("banned");
  });
});

describe("X-6 — no self-review", () => {
  it("refuses to resolve a case about the reviewer's own account, even when already claimed by them", async () => {
    setBy("active", "banned");
    const submitted = await submitForReview({
      source: "ban_review",
      moderationResult: makeModerationResult(),
      targetUserId: TARGET,
      requestId: "req-self",
    });
    await store.update(submitted.item!.id, {
      status: "claimed",
      claimedBy: TARGET,
      claimedAt: new Date().toISOString(),
    });
    const res = await overturn(submitted.item!.id, TARGET);
    expect(res).toMatchObject({ success: false, errorCode: "moderation.self_review" });
    expect(user().account_status).toBe("banned");
  });

  it("refuses a moderator claiming a case about their own account", async () => {
    const { claimed } = await submitAndClaim({ source: "ban_review", reviewer: TARGET });
    expect(claimed).toMatchObject({
      success: false,
      errorCode: "moderation.self_review",
    });
    expect(user().account_status).toBe("banned");
  });
});

describe("X-8 — recorded first, and nothing half-done", () => {
  it("records the resolution before restoring the account", async () => {
    setBy("active", "banned");
    const { id } = await submitAndClaim({ source: "ban_review" });
    await overturn(id);
    const order = db.writes.map(([op, table]) => `${op} ${table}`);
    expect(order[0]).toBe("insert audit_log");
    expect(order).toContain("update users");
    expect(
      db.rows("audit_log").find((r) => r.details?.type === "review_resolution")
    ).toMatchObject({
      actor_id: REVIEWER,
      target_id: TARGET,
      details: expect.objectContaining({
        type: "review_resolution",
        decision: "overturn",
      }),
    });
  });

  it("changes nothing and keeps the item claimed when the audit log is unavailable", async () => {
    setBy("active", "banned");
    const { id } = await submitAndClaim({ source: "ban_review" });
    db.failWrites("audit_log");
    const res = await overturn(id);
    expect(res).toMatchObject({ success: false, errorCode: "service.unavailable" });
    expect(user().account_status).toBe("banned");
    const retry = await claimItem(id, REVIEWER);
    expect(retry).toMatchObject({ errorCode: "moderation.item_state_conflict" }); // still claimed
  });

  it("keeps the item claimed, for a retry, when the account cannot be restored", async () => {
    setBy("active", "banned");
    const { id } = await submitAndClaim({ source: "ban_review" });
    db.failWrites("users");
    const res = await overturn(id);
    expect(res.success).toBe(false);
    db.failing.delete("users");
    const second = await overturn(id);
    expect(second.success).toBe(true);
    expect(user().account_status).toBe("active");
  });
});
