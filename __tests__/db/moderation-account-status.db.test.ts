/**
 * @jest-environment node
 */
/**
 * The moderation account-status SQL against the replayed database (ADR-053 D4): an overturn's
 * restoration in review-service (the account row locked, its recorded history read, the
 * restoration written — one transaction), and Sentinel's status read and change. Runs the real
 * services with the Postgres review queue and strike stores, the real audit module, in a fresh
 * tenant per test. Query failures are injected per statement (helpers/data-faults.ts).
 */

jest.mock("@/platform/data", () => require("../helpers/data-faults").withFaults());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(async (_key: string, dflt: unknown) => dflt),
}));
jest.mock("@/platform/moderation/config", () => ({
  ...jest.requireActual("@/platform/moderation/config"),
  loadStrikeThresholds: jest.fn(async () => ({ warnAt: 1, suspendAt: 2, banAt: 3 })),
}));

import { randomUUID } from "node:crypto";
import { clearFaults, faults } from "../helpers/data-faults";
import { DataUnavailableError, withTenantTx } from "@/platform/data";
import {
  claimItem,
  resolveItem,
  submitForReview,
} from "@/platform/moderation/review-service";
import {
  InMemoryReviewQueueStore,
  PostgresReviewQueueStore,
  resetReviewQueueStore,
  setReviewQueueStore,
} from "@/platform/moderation/review-store";
import {
  PostgresStrikeStore,
  resetStrikeStore,
  setStrikeStore,
} from "@/platform/moderation/strikes";
import { Sentinel } from "@/platform/moderation/sentinel";
import type { AccountStatus, ModerationResult } from "@/platform/moderation/types";
import { registerPlatformAgents } from "@/platform/agents/agent-configs";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const DECISION = "traj-db";

function result(overrides: Partial<ModerationResult> = {}): ModerationResult {
  return {
    action: "block",
    triggeredBy: "classifier",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    classifierOutput: {
      safe: false,
      categories: ["harassment"],
      confidence: 0.9,
      severity: "medium",
    },
    reasoning: "db test",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 1,
    classifierCostUsd: 0,
    trajectoryId: DECISION,
    agentId: "guardian",
    ...overrides,
  };
}

interface UserRow {
  account_status: AccountStatus;
  banned_at: Date | null;
  ban_reason: string | null;
  suspended_until: Date | null;
  restricted_until: Date | null;
  status_changed_by: string | null;
  status_changed_at: Date | null;
}

let t: TestTenant;
let target: string;
let reviewer: string;

const inT = <T>(fn: () => Promise<T>) => t.run(fn);

async function account(): Promise<UserRow> {
  const { rows } = await inT(() =>
    withTenantTx((tx) =>
      tx.query<UserRow>(
        `select account_status, banned_at, ban_reason, suspended_until, restricted_until,
                status_changed_by, status_changed_at
           from users where id = $1::uuid`,
        [target]
      )
    )
  );
  return rows[0];
}

/** The account as a decision left it: status, a ban, and end dates on both restrictions. */
async function setAccount(status: AccountStatus): Promise<void> {
  await inT(() =>
    withTenantTx((tx) =>
      tx.query(
        `update users set account_status = $2::account_status,
            banned_at = case when $2::text = 'banned' then now() end,
            ban_reason = case when $2::text = 'banned' then 'test ban' end,
            suspended_until = now() + interval '30 days',
            restricted_until = now() + interval '30 days'
          where id = $1::uuid`,
        [target, status]
      )
    )
  );
}

/** A Sentinel status-change record, as sentinel.ts writes it. */
async function recordChange(c: {
  decision: string;
  from: AccountStatus;
  to: AccountStatus;
  at: string;
  outcome?: "attempted" | "failed";
}): Promise<void> {
  await inT(() =>
    withTenantTx((tx) =>
      tx.query(
        `insert into audit_log (action, target_id, details, created_at)
         values ('admin_action', $1::uuid, $2::jsonb, $3::timestamptz)`,
        [
          target,
          JSON.stringify({
            type: "sentinel_status_change",
            agent: "sentinel",
            previousStatus: c.from,
            newStatus: c.to,
            guardianDecisionId: c.decision,
            outcome: c.outcome ?? "attempted",
          }),
          c.at,
        ]
      )
    )
  );
}

/** Set by the decision under review, from `from`. */
async function setBy(from: AccountStatus, to: AccountStatus): Promise<void> {
  await setAccount(to);
  await recordChange({ decision: DECISION, from, to, at: "2026-10-01T00:00:00Z" });
}

async function submitAndClaim(
  source: "ban_review" | "appeal" | "escalation" = "ban_review"
) {
  return inT(async () => {
    const submitted = await submitForReview({
      source,
      moderationResult: result({
        action: source === "escalation" ? "escalate" : "block",
      }),
      targetUserId: target,
      requestId: "req-db",
    });
    expect(submitted.success).toBe(true);
    const claimed = await claimItem(submitted.item!.id, reviewer);
    expect(claimed.success).toBe(true);
    return submitted.item!.id;
  });
}

const overturn = (id: string) =>
  inT(() =>
    resolveItem({
      itemId: id,
      reviewerId: reviewer,
      decision: "overturn",
      reviewerNotes: "db overturn",
    })
  );

const status = async (id: string) =>
  (await inT(() => new PostgresReviewQueueStore().getById(id)))?.status;

dbDescribe("moderation account-status SQL", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    registerPlatformAgents();
  });
  beforeEach(async () => {
    t = await createTestTenant();
    target = await t.user("target");
    reviewer = await t.user("reviewer");
    setReviewQueueStore(new PostgresReviewQueueStore());
    setStrikeStore(new PostgresStrikeStore());
  });
  afterEach(() => {
    clearFaults();
    resetReviewQueueStore();
    resetStrikeStore();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  describe("overturn restoration (review-service)", () => {
    it("restores the recorded previous status, lifting the ban and both end dates", async () => {
      await setBy("warned", "banned");
      const id = await submitAndClaim();
      const res = await overturn(id);
      expect(res).toMatchObject({ success: true });
      expect(res.item?.status).toBe("resolved");
      expect(await account()).toMatchObject({
        account_status: "warned",
        banned_at: null,
        ban_reason: null,
        suspended_until: null,
        restricted_until: null,
        status_changed_by: reviewer,
        status_changed_at: expect.any(Date),
      });
    });

    it("keeps suspended_until when restoring into suspended", async () => {
      await setBy("suspended", "banned");
      await overturn(await submitAndClaim());
      const a = await account();
      expect(a.account_status).toBe("suspended");
      expect(a.suspended_until).toEqual(expect.any(Date));
      expect(a.restricted_until).toBeNull();
    });

    it("keeps restricted_until when restoring into restricted", async () => {
      await setBy("restricted", "banned");
      await overturn(await submitAndClaim("appeal"));
      const a = await account();
      expect(a.account_status).toBe("restricted");
      expect(a.restricted_until).toEqual(expect.any(Date));
      expect(a.suspended_until).toBeNull();
    });

    it("expires the strike the overturned decision caused", async () => {
      await setBy("active", "warned");
      const strikes = new PostgresStrikeStore();
      await inT(() =>
        strikes.recordStrike({
          userId: target,
          category: "harassment",
          severity: "medium",
          moderationAuditId: null,
          guardianDecisionId: DECISION,
          trajectoryId: "s",
          agentId: "sentinel",
          reason: "r",
          expiresAt: null,
          expired: false,
        })
      );
      await overturn(await submitAndClaim());
      expect(await inT(() => strikes.getActiveStrikes(target))).toEqual([]);
      expect((await account()).account_status).toBe("active");
    });

    it("leaves the account as it is when no record shows this decision set it", async () => {
      await setAccount("banned");
      expect((await overturn(await submitAndClaim())).success).toBe(true);
      expect((await account()).account_status).toBe("banned");
    });

    it("does not lift a later decision's status, nor count a change recorded as failed", async () => {
      await setAccount("banned");
      await recordChange({
        decision: DECISION,
        from: "active",
        to: "warned",
        at: "2026-10-01T00:00:00Z",
      });
      await recordChange({
        decision: "later",
        from: "warned",
        to: "banned",
        at: "2026-10-05T00:00:00Z",
      });
      await overturn(await submitAndClaim("appeal"));
      expect((await account()).account_status).toBe("banned");

      await setAccount("warned");
      await recordChange({
        decision: DECISION,
        from: "warned",
        to: "banned",
        at: "2026-10-06T00:00:00Z",
      });
      await recordChange({
        decision: DECISION,
        from: "warned",
        to: "banned",
        at: "2026-10-06T00:00:01Z",
        outcome: "failed",
      });
      await overturn(await submitAndClaim("appeal"));
      expect((await account()).account_status).toBe("warned");
    });

    it("never raises a status, whatever the record says", async () => {
      await setBy("banned", "warned");
      await overturn(await submitAndClaim());
      expect((await account()).account_status).toBe("warned");
    });

    it("does not touch the account on an escalation overturn", async () => {
      await setBy("active", "banned");
      faults.fail = (sql) =>
        /users/.test(sql) ? new Error("must not be reached") : undefined;
      expect((await overturn(await submitAndClaim("escalation"))).success).toBe(true);
      clearFaults();
      expect((await account()).account_status).toBe("banned");
    });

    it("answers account not found for a user it cannot see, and keeps the item claimed", async () => {
      setReviewQueueStore(new InMemoryReviewQueueStore());
      const other = await (await createTestTenant()).user("elsewhere");
      const id = await inT(async () => {
        const s = await submitForReview({
          source: "ban_review",
          moderationResult: result(),
          targetUserId: other,
          requestId: "req-other",
        });
        await claimItem(s.item!.id, reviewer);
        return s.item!.id;
      });
      expect(await overturn(id)).toMatchObject({
        success: false,
        error: "account not found",
        errorCode: "internal.error",
      });
    });

    it.each([
      [
        "the account cannot be read",
        /^select account_status from users/,
        /account status unreadable/,
      ],
      [
        "the history cannot be read",
        /^select details from audit_log/,
        /status history unreadable/,
      ],
      [
        "the restoration cannot be written",
        /^update users/,
        /account status restore failed/,
      ],
    ])(
      "changes nothing and keeps the item claimed when %s; a retry then succeeds",
      async (_label, statement, message) => {
        await setBy("active", "banned");
        const id = await submitAndClaim();
        faults.fail = (sql) =>
          statement.test(sql.trim()) ? new DataUnavailableError("injected") : undefined;
        const res = await overturn(id);
        expect(res).toMatchObject({ success: false, errorCode: "internal.error" });
        expect(res.error).toMatch(message);
        expect((await account()).account_status).toBe("banned");
        expect(await status(id)).toBe("claimed");

        clearFaults();
        expect((await overturn(id)).success).toBe(true);
        expect((await account()).account_status).toBe("active");
      }
    );
  });

  describe("Sentinel status changes", () => {
    const block = (requestId: string) =>
      inT(() => new Sentinel().processBlock(result(), target, requestId));

    it("reads the status, then warns, suspends with an end date, and bans with a reason", async () => {
      const first = await block("r1");
      expect(first).toMatchObject({ previousStatus: "active", newStatus: "warned" });
      expect(await account()).toMatchObject({
        account_status: "warned",
        status_changed_at: expect.any(Date),
        suspended_until: null,
        banned_at: null,
      });

      const second = await block("r2");
      expect(second).toMatchObject({ previousStatus: "warned", newStatus: "suspended" });
      const suspended = await account();
      expect(suspended.account_status).toBe("suspended");
      // 7 days by default (getConfig answers its default here).
      const days = (suspended.suspended_until!.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);

      const third = await block("r3");
      expect(third).toMatchObject({ previousStatus: "suspended", newStatus: "banned" });
      expect(await account()).toMatchObject({
        account_status: "banned",
        banned_at: expect.any(Date),
        ban_reason: "Automatic ban: strike threshold exceeded",
        // A ban leaves the suspension's end as it was.
        suspended_until: suspended.suspended_until,
      });
    });

    it("reads an unreadable status as active (fail-open read, L19 strike still recorded)", async () => {
      await setAccount("warned");
      faults.fail = (sql) =>
        /^select account_status from users/.test(sql.trim())
          ? new DataUnavailableError("injected")
          : undefined;
      const res = await block("r-unreadable");
      expect(res.previousStatus).toBe("active");
    });

    it("reports the consequence as not applied when the status cannot be written", async () => {
      faults.fail = (sql) =>
        /^update users/.test(sql.trim())
          ? new DataUnavailableError("injected")
          : undefined;
      const res = await block("r-unwritable");
      expect(res.reasoning).toContain("consequence not applied");
      clearFaults();
      expect((await account()).account_status).toBe("active");
    });

    it("review 15 L1: a re-linked account's token verifications are revoked by its subject (users.cognito_sub), not its id", async () => {
      const { getCache } = await import("@/platform/cache");
      const subject = randomUUID();
      // A re-linked account (TASK-174): its id stays, its subject is the new pool's.
      await inT(() =>
        withTenantTx((tx) =>
          tx.query("update users set cognito_sub = $2 where id = $1::uuid", [
            target,
            subject,
          ])
        )
      );
      const stamp = (sub: string) => getCache().get<string>(`auth:token-revoked:${sub}`);
      const before = await stamp(subject);
      await block("r-relinked");
      expect((await account()).account_status).toBe("warned");
      const after = await stamp(subject);
      expect(after).toEqual(expect.any(String));
      expect(after).not.toBe(before);
      // Nothing published under the id: no token names it.
      await expect(stamp(target)).resolves.toBeFalsy();
    });

    it("reads a user it cannot see as active", async () => {
      const res = await inT(() =>
        new Sentinel().processBlock(result(), randomUUID(), "r-unknown")
      );
      expect(res.previousStatus).toBe("active");
    });
  });
});
