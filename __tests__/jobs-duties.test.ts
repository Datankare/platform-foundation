/**
 * @jest-environment node
 */
/**
 * platform/jobs/duties.ts (ADR-056 D3): each core duty calls its domain function, reports its
 * counts, turns a partial failure into a failed attempt (so it retries and, at last, is
 * dead-lettered) and continues in a next part when its batch was full. The domain functions have
 * their own tests (and run for real in __tests__/db/jobs.db.test.ts); here they are stubbed.
 */

jest.mock("@/platform/moderation/review-service", () => ({
  reapOverdueEscalations: jest.fn(),
  releaseExpiredClaims: jest.fn(),
}));
jest.mock("@/platform/moderation/strikes", () => ({
  getStrikeStore: () => ({ expireStrikes: mockExpireStrikes }),
}));
jest.mock("@/platform/auth/account-status-guard", () => ({
  expireLapsedAccountStatuses: jest.fn(),
}));
jest.mock("@/platform/auth/gdpr-deletion", () => ({ purgeDueErasures: jest.fn() }));
jest.mock("@/platform/agents/trajectory-retention", () => ({
  applyTrajectoryRetention: jest.fn(),
}));
jest.mock("@/platform/admin/config-approval", () => ({
  expireStaleApprovals: jest.fn(),
}));
jest.mock("@/platform/tenancy/admin", () => ({ purgeDueTenants: jest.fn() }));
jest.mock("@/platform/auth/platform-config", () => ({
  getConfigNumber: jest.fn(async (_k: string, d: number) => d),
}));

const mockExpireStrikes = jest.fn();

import { CORE_JOBS, resolveJobRetentionDays } from "@/platform/jobs/duties";
import {
  InMemoryJobStore,
  JobFailure,
  resetJobStore,
  setJobStore,
} from "@/platform/jobs";
import type { JobContext } from "@/platform/jobs/types";
import {
  reapOverdueEscalations,
  releaseExpiredClaims,
} from "@/platform/moderation/review-service";
import { expireLapsedAccountStatuses } from "@/platform/auth/account-status-guard";
import { purgeDueErasures } from "@/platform/auth/gdpr-deletion";
import { applyTrajectoryRetention } from "@/platform/agents/trajectory-retention";
import { expireStaleApprovals } from "@/platform/admin/config-approval";
import { purgeDueTenants } from "@/platform/tenancy/admin";
import { getConfigNumber } from "@/platform/auth/platform-config";

const signal = new AbortController().signal;
const duty = (kind: string) => {
  const d = CORE_JOBS.find((j) => j.kind === kind);
  if (!d) throw new Error(`no duty ${kind}`);
  return (ctx: Partial<JobContext> = {}) =>
    d.handler({ agent: `job:${kind}`, payload: {}, signal, ...ctx } as JobContext);
};

beforeEach(() => jest.clearAllMocks());

describe("the core duties", () => {
  it("are nine, all recurring, each with a description", () => {
    expect(CORE_JOBS.map((j) => j.kind)).toEqual([
      "moderation.escalation-reaper",
      "moderation.release-claims",
      "moderation.expire-strikes",
      "accounts.expire-restrictions",
      "gdpr.retention-purge",
      "agents.trajectory-retention",
      "config.expire-approvals",
      "tenancy.purge-due",
      "jobs.prune",
    ]);
    expect(CORE_JOBS.every((j) => j.schedule && j.description.length > 20)).toBe(true);
  });

  it("declares the legal obligations as running for suspended tenants, and nothing else", () => {
    expect(
      CORE_JOBS.filter((j) => j.runsForSuspended)
        .map((j) => j.kind)
        .sort()
    ).toEqual(["agents.trajectory-retention", "gdpr.retention-purge"]);
  });

  // Review finding 3: a duty that works item by item is given the job's signal and, told to
  // stop (its time is up, or the instance is stopping), stops at the next item and continues
  // in a next part — it never keeps working beside its own retry.
  it("passes the job's signal to every item-by-item duty, and continues when it stopped early", async () => {
    const stop = new AbortController();
    stop.abort();
    const ctx = { signal: stop.signal };
    (reapOverdueEscalations as jest.Mock).mockResolvedValue({
      scanned: 9,
      blocked: 1,
      escalatedHigher: 0,
      slaHours: 24,
      cutoff: "x",
      stopped: true,
    });
    expect(await duty("moderation.escalation-reaper")(ctx)).toMatchObject({
      continueWith: { part: "next" },
    });
    expect((reapOverdueEscalations as jest.Mock).mock.calls[0][1]).toBe(stop.signal);
    (expireLapsedAccountStatuses as jest.Mock).mockResolvedValue({
      lapsed: 4,
      expired: 1,
      skipped: 0,
      stopped: true,
    });
    expect(await duty("accounts.expire-restrictions")(ctx)).toMatchObject({
      continueWith: { part: "next" },
    });
    expect((expireLapsedAccountStatuses as jest.Mock).mock.calls[0][2]).toBe(stop.signal);
    (purgeDueErasures as jest.Mock).mockResolvedValue({
      due: 3,
      purged: 1,
      failed: 0,
      stopped: true,
    });
    expect(await duty("gdpr.retention-purge")(ctx)).toMatchObject({
      continueWith: { part: "next" },
    });
    expect((purgeDueErasures as jest.Mock).mock.calls[0][2]).toBe(stop.signal);
    (purgeDueTenants as jest.Mock).mockResolvedValue({ ok: true, value: [] });
    expect(await duty("tenancy.purge-due")(ctx)).toMatchObject({
      continueWith: { part: "next" },
    });
    expect((purgeDueTenants as jest.Mock).mock.calls[0][1]).toEqual({
      signal: stop.signal,
    });
  });

  it("the reaper reports what it scanned and remedied", async () => {
    (reapOverdueEscalations as jest.Mock).mockResolvedValue({
      scanned: 3,
      blocked: 2,
      escalatedHigher: 0,
      slaHours: 24,
      cutoff: "x",
    });
    await expect(duty("moderation.escalation-reaper")()).resolves.toEqual({
      summary: { scanned: 3, blocked: 2, escalatedHigher: 0, slaHours: 24 },
    });
  });

  it("claim release and strike expiry report their counts; a failure propagates", async () => {
    (releaseExpiredClaims as jest.Mock).mockResolvedValue(4);
    mockExpireStrikes.mockResolvedValue(2);
    await expect(duty("moderation.release-claims")()).resolves.toEqual({
      summary: { released: 4 },
    });
    await expect(duty("moderation.expire-strikes")()).resolves.toEqual({
      summary: { expired: 2 },
    });
    mockExpireStrikes.mockRejectedValue(new Error("down"));
    await expect(duty("moderation.expire-strikes")()).rejects.toThrow("down");
  });

  it("lapsed restrictions act as the job and continue while a full batch changed something", async () => {
    (expireLapsedAccountStatuses as jest.Mock).mockResolvedValue({
      lapsed: 500,
      expired: 3,
      skipped: 497,
    });
    const r = await duty("accounts.expire-restrictions")();
    expect(expireLapsedAccountStatuses).toHaveBeenCalledWith(
      "job:accounts.expire-restrictions",
      500,
      signal
    );
    expect(r).toMatchObject({ continueWith: { part: "next" } });
    // A full batch of skips only (records unwritable): no next part, so no loop.
    (expireLapsedAccountStatuses as jest.Mock).mockResolvedValue({
      lapsed: 500,
      expired: 0,
      skipped: 500,
    });
    expect(await duty("accounts.expire-restrictions")()).not.toHaveProperty(
      "continueWith"
    );
  });

  it("the GDPR purge fails the attempt when an erasure did not complete, and continues a full batch", async () => {
    (purgeDueErasures as jest.Mock).mockResolvedValue({ due: 3, purged: 1, failed: 2 });
    const failing = duty("gdpr.retention-purge")();
    await expect(failing).rejects.toBeInstanceOf(JobFailure);
    await expect(failing).rejects.toThrow("2 of 3 due erasures did not complete");
    (purgeDueErasures as jest.Mock).mockResolvedValue({
      due: 100,
      purged: 100,
      failed: 0,
    });
    expect(await duty("gdpr.retention-purge")()).toMatchObject({
      summary: { due: 100, purged: 100 },
      continueWith: { part: "next" },
    });
  });

  it("trajectory retention continues while there may be more", async () => {
    (applyTrajectoryRetention as jest.Mock).mockResolvedValue({
      deleted: 5000,
      retentionDays: 90,
      more: true,
    });
    expect(await duty("agents.trajectory-retention")()).toMatchObject({
      continueWith: {},
    });
    (applyTrajectoryRetention as jest.Mock).mockResolvedValue({
      deleted: 1,
      retentionDays: 90,
      more: false,
    });
    expect(await duty("agents.trajectory-retention")()).toEqual({
      summary: { deleted: 1, retentionDays: 90 },
    });
  });

  it("expires stale approvals", async () => {
    (expireStaleApprovals as jest.Mock).mockResolvedValue(7);
    await expect(duty("config.expire-approvals")()).resolves.toEqual({
      summary: { expired: 7 },
    });
  });

  it("purges due tenants as the job — named as an agent, never as a user — and fails on refusal", async () => {
    (purgeDueTenants as jest.Mock).mockResolvedValue({
      ok: true,
      value: [
        { tenantId: "t1", rows: 10 },
        { tenantId: "t2", rows: 5 },
      ],
    });
    await expect(duty("tenancy.purge-due")()).resolves.toEqual({
      summary: { tenants: 2, rows: 15 },
    });
    expect(purgeDueTenants).toHaveBeenCalledWith(
      { agent: "job:tenancy.purge-due" },
      { signal }
    );
    (purgeDueTenants as jest.Mock).mockResolvedValue({
      ok: false,
      code: "audit.unavailable",
      message: "The audit log is unavailable, so nothing was changed.",
    });
    await expect(duty("tenancy.purge-due")()).rejects.toThrow(
      "The audit log is unavailable, so nothing was changed."
    );
  });

  it("prunes the job history by the governed retention, clamped", async () => {
    const store = new InMemoryJobStore({ activeTenants: async () => [] });
    setJobStore(store);
    const prune = jest.spyOn(store, "prune").mockResolvedValue(5000);
    try {
      expect(await duty("jobs.prune")()).toMatchObject({
        summary: { deleted: 5000, retentionDays: 30 },
        continueWith: {},
      });
      const cutoff = prune.mock.calls[0][0].getTime();
      expect(Math.abs(Date.now() - 30 * 86_400_000 - cutoff)).toBeLessThan(5_000);
      for (const [v, want] of [
        [0, 1],
        [9999, 365],
        [NaN, 30],
        [12.7, 12],
      ] as const) {
        (getConfigNumber as jest.Mock).mockResolvedValueOnce(v);
        expect(await resolveJobRetentionDays()).toBe(want);
      }
    } finally {
      resetJobStore();
    }
  });
});
