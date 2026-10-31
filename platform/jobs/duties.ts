/**
 * platform/jobs/duties.ts — the core's timed duties, each a recurring job (ADR-056 D3, TASK-141)
 *
 * Every function the platform documents as scheduled (`@scheduled <kind>` in its JSDoc) is run by
 * one of these; __tests__/jobs-scheduled-coverage.test.ts fails when a tagged function has no
 * job, when a recurring job has no tagged function or seeded settings, and when a defaults here
 * differ from the seeds (migration 050). A module's duties are its own (its `jobs`).
 *
 *   kind                           runs for        does
 *   moderation.escalation-reaper   each tenant     over-SLA escalations remedied (ADR-041)
 *   moderation.release-claims      each tenant     timed-out review claims back to the queue
 *   moderation.expire-strikes      each tenant     strikes past their expiry marked expired
 *   accounts.expire-restrictions   each tenant     lapsed restrictions/suspensions → warned
 *   gdpr.retention-purge           each tenant*    erasures past their retention period completed;
 *                                                  unrecorded erasures recorded, children's
 *                                                  accounts past their consent period erased,
 *                                                  external erasures retried (TASK-193)
 *   agents.trajectory-retention    each tenant*    abandoned open trajectories ended (TASK-193), then
 *                                                  finished ones past retention deleted
 *   config.expire-approvals        platform        stale configuration approvals expired (TASK-036)
 *   tenancy.purge-due              platform        deleted tenants past their purge time purged
 *   jobs.prune                     platform        succeeded jobs past jobs.retention_days deleted
 *
 *   * every active tenant and every suspended one (runsForSuspended)
 *
 * A handler reports counts (the log line) and, when a run's batch was full, continues in a next
 * part rather than running past its time. Each duty that works item by item is given the job's
 * signal (ctx.signal) and checks it between items: when the attempt's time is up or the instance
 * is stopping, it stops at the next item boundary and the rest continues in a next part — so a
 * timed-out handler does not keep running beside its retry. The duties that are one statement
 * (strike expiry, claim release, trajectory retention, approval expiry, prune) end on their own.
 *
 * gdpr.retention-purge and agents.trajectory-retention run for suspended tenants too
 * (runsForSuspended): erasure and storage limitation are legal obligations a suspension does not
 * pause. A deleted tenant's jobs never run — its purge removes everything.
 *
 * @module platform/jobs
 */

import { expireStaleApprovals } from "@/platform/admin/config-approval";
import { applyTrajectoryRetention } from "@/platform/agents/trajectory-retention";
import { expireLapsedAccountStatuses } from "@/platform/auth/account-status-guard";
import {
  eraseMentionsInOtherTenants,
  purgeDueErasures,
  reconcileErasures,
  retryExternalErasures,
} from "@/platform/auth/gdpr-deletion";
import { expireParentalConsent } from "@/platform/auth/coppa";
import { upgradeLegacyErasureHashes } from "@/platform/auth/user-provisioning";
import { getConfigNumber } from "@/platform/auth/platform-config";
import {
  reapOverdueEscalations,
  releaseExpiredClaims,
} from "@/platform/moderation/review-service";
import { getStrikeStore } from "@/platform/moderation/strikes";
import { purgeDueTenants } from "@/platform/tenancy/admin";
import { JobFailure } from "./errors";
import { getJobStore } from "./store";
import type { JobDefinition, JobResult } from "./types";

/** Accounts handled per run by the batch duties; a full batch continues in a next part. */
const ACCOUNT_BATCH = 500;
const ERASURE_BATCH = 100;
const PRUNE_BATCH = 5000;

export const JOB_RETENTION_KEY = "jobs.retention_days";
export const DEFAULT_JOB_RETENTION_DAYS = 30;

const more = (full: boolean): Pick<JobResult, "continueWith"> =>
  full ? { continueWith: { part: "next" } } : {};

export const CORE_JOBS: readonly JobDefinition[] = Object.freeze([
  {
    kind: "moderation.escalation-reaper",
    description:
      "Applies the configured remedy to escalations left over their SLA without a decision (ADR-041).",
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 15,
      minIntervalMinutes: 5,
      maxIntervalMinutes: 60,
    },
    handler: async (ctx) => {
      const r = await reapOverdueEscalations(new Date(), ctx.signal);
      return {
        summary: {
          scanned: r.scanned,
          blocked: r.blocked,
          escalatedHigher: r.escalatedHigher,
          slaHours: r.slaHours,
        },
        ...more(r.stopped),
      };
    },
  },
  {
    kind: "moderation.release-claims",
    description: "Returns review items whose claim timed out to the queue.",
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 15,
      minIntervalMinutes: 5,
      maxIntervalMinutes: 120,
    },
    handler: async () => ({ summary: { released: await releaseExpiredClaims() } }),
  },
  {
    kind: "moderation.expire-strikes",
    description: "Marks strikes past their expiry as expired.",
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 60,
      minIntervalMinutes: 15,
      maxIntervalMinutes: 1440,
    },
    handler: async () => ({
      summary: { expired: await getStrikeStore().expireStrikes() },
    }),
  },
  {
    kind: "accounts.expire-restrictions",
    description:
      "Steps restricted or suspended accounts whose end date has passed down to warned.",
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 60,
      minIntervalMinutes: 15,
      maxIntervalMinutes: 1440,
    },
    handler: async (ctx) => {
      const r = await expireLapsedAccountStatuses(ctx.agent, ACCOUNT_BATCH, ctx.signal);
      return {
        summary: { lapsed: r.lapsed, expired: r.expired, skipped: r.skipped },
        ...more(r.stopped || (r.lapsed >= ACCOUNT_BATCH && r.expired > 0)),
      };
    },
  },
  {
    kind: "gdpr.retention-purge",
    description:
      "Completes the erasure (hard purge) of accounts whose GDPR retention period has passed.",
    runsForSuspended: true,
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 1440,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 1440,
    },
    handler: async (ctx) => {
      // Legacy unkeyed address hashes become the current key's first (review 8 L6).
      const upgraded = await upgradeLegacyErasureHashes(ACCOUNT_BATCH);
      // TASK-193: an account marked deleted without its erasure record is recorded (B-6); a
      // child's account whose consent was not given in time is erased (B-10, COPPA); the stores
      // outside the database still holding an erased person are tried again (B-8/D-9).
      const reconciled = await reconcileErasures(ctx.agent, ACCOUNT_BATCH);
      const consent = await expireParentalConsent(ERASURE_BATCH, ctx.signal);
      const external = await retryExternalErasures(ERASURE_BATCH, ctx.signal);
      const r = await purgeDueErasures(ctx.agent, ERASURE_BATCH, ctx.signal);
      // An erased account's mentions in other tenants' audit records (an operator's act) (A-3).
      const mentions = await eraseMentionsInOtherTenants(ERASURE_BATCH, ctx.signal);
      // A failed erasure is retried later with a growing interval and alerted once it keeps
      // failing (purgeDueErasures); the run goes on to the next part, so the erasures that always
      // fail never hold the others back (B-7: the run failed before it could continue).
      return {
        summary: {
          due: r.due,
          purged: r.purged,
          failed: r.failed,
          stuck: r.stuck,
          hashesUpgraded: upgraded,
          reconciled,
          consentExpired: consent.erased,
          externalDone: external.done,
          externalPending: external.pending,
          mentionsErased: mentions.erased,
        },
        ...more(
          r.stopped ||
            consent.stopped ||
            external.stopped ||
            mentions.stopped ||
            mentions.due >= ERASURE_BATCH ||
            r.due >= ERASURE_BATCH ||
            consent.due >= ERASURE_BATCH ||
            external.due >= ERASURE_BATCH ||
            reconciled >= ACCOUNT_BATCH ||
            upgraded >= ACCOUNT_BATCH
        ),
      };
    },
  },
  {
    kind: "agents.trajectory-retention",
    description:
      "Ends open agent trajectories with no activity for agent.trajectory.abandon_after_hours and no open hold, then deletes completed and failed ones older than agent.trajectory.retention_days.",
    runsForSuspended: true,
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 1440,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 10080,
    },
    handler: async () => {
      const r = await applyTrajectoryRetention();
      return {
        summary: {
          deleted: r.deleted,
          retentionDays: r.retentionDays,
          abandoned: r.abandoned,
          abandonHours: r.abandonHours,
        },
        ...more(r.more),
      };
    },
  },
  {
    kind: "config.expire-approvals",
    description: "Marks pending configuration approvals past their expiry as expired.",
    schedule: {
      scope: "platform",
      defaultIntervalMinutes: 60,
      minIntervalMinutes: 15,
      maxIntervalMinutes: 1440,
    },
    handler: async () => ({ summary: { expired: await expireStaleApprovals() } }),
  },
  {
    kind: "tenancy.purge-due",
    description: "Purges the data of deleted tenants whose purge time has passed.",
    schedule: {
      scope: "platform",
      defaultIntervalMinutes: 60,
      minIntervalMinutes: 15,
      maxIntervalMinutes: 1440,
    },
    handler: async (ctx) => {
      const r = await purgeDueTenants({ agent: ctx.agent }, { signal: ctx.signal });
      if (!r.ok) throw new JobFailure(r.message);
      return {
        summary: {
          tenants: r.value.length,
          rows: r.value.reduce((n, t) => n + t.rows, 0),
        },
        ...more(ctx.signal.aborted),
      };
    },
  },
  {
    kind: "jobs.prune",
    description:
      "Deletes succeeded jobs older than jobs.retention_days; dead jobs stay until an operator acts.",
    schedule: {
      scope: "platform",
      defaultIntervalMinutes: 1440,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 10080,
    },
    handler: async () => {
      const days = await resolveJobRetentionDays();
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
      const deleted = await pruneJobHistory(cutoff, PRUNE_BATCH);
      return {
        summary: { deleted, retentionDays: days },
        ...more(deleted >= PRUNE_BATCH),
      };
    },
  },
] satisfies JobDefinition[]);

/** The job history's retention in days: the governed value, clamped to 1–365, else 30. */
export async function resolveJobRetentionDays(): Promise<number> {
  const v = await getConfigNumber(JOB_RETENTION_KEY, DEFAULT_JOB_RETENTION_DAYS);
  if (!Number.isFinite(v)) return DEFAULT_JOB_RETENTION_DAYS;
  return Math.min(365, Math.max(1, Math.floor(v)));
}

/**
 * Delete succeeded jobs finished before `cutoff`, at most `limit`.
 *
 * @scheduled jobs.prune
 */
export function pruneJobHistory(cutoff: Date, limit: number): Promise<number> {
  return getJobStore().prune(cutoff, limit);
}
