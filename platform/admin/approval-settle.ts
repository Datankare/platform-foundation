/**
 * platform/admin/approval-settle.ts — how long an approval whose outcome is being checked waits
 * to be settled (TASK-194 round 16, item 4; rounds 17–18)
 *
 * An approved run that may have applied — a config approval whose apply lost its commit, a
 * runtime hold whose claim was not given back — is settled by the approval-expiry job
 * (config.expire-approvals): recoverUnappliedApprovals and recoverStaleRuns, each once its lease
 * has passed. That job is required (round 18: its enabled setting is ignored and refused), so the
 * bound a screen gives is always the lease, plus the job's interval as the platform schedules it,
 * plus one tick of the job runner (vercel.json: every five minutes).
 */

import { CORE_JOBS } from "@/platform/jobs/duties";
import { resolveDefinition } from "@/platform/jobs/registry";
import { scheduleInterval } from "@/platform/jobs/runner";
import { runWithoutTenant } from "@/platform/tenancy/context";

/** The job that settles approvals (platform/jobs/duties.ts). */
export const SETTLING_JOB = "config.expire-approvals";

/** The job runner's tick (vercel.json `*\/5 * * * *`; the CLI worker ticks as often). */
export const JOB_TICK_MINUTES = 5;

/**
 * Minutes within which an approval under a lease of `leaseSeconds` is settled, at the latest. The
 * interval is the platform's schedule, read without a tenant as the scheduler reads it
 * (takeDueSlots; round 18, I-2): a decision is made inside a tenant, whose own override of the
 * setting is not the schedule the job runs on.
 */
export async function settlesWithinMinutes(leaseSeconds: number): Promise<number> {
  const def = CORE_JOBS.find((j) => j.kind === SETTLING_JOB);
  const resolved = def ? resolveDefinition(def) : undefined;
  const interval =
    resolved?.schedule !== undefined
      ? await runWithoutTenant(() =>
          scheduleInterval(
            resolved as typeof resolved & {
              schedule: NonNullable<typeof resolved.schedule>;
            }
          )
        )
      : 60;
  return Math.ceil(leaseSeconds / 60) + interval + JOB_TICK_MINUTES;
}
