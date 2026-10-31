/**
 * platform/agents/trajectory-retention.ts — finished trajectories are kept for a governed time,
 * and open ones nobody will end are ended first
 *
 * `agent.trajectory.retention_days` (migration 016, tenant settable) says how long a completed
 * or failed trajectory is kept; nothing enforced it (TASK-141). applyTrajectoryRetention deletes
 * the current tenant's finished trajectories older than that, a bounded batch per run; the
 * agents.trajectory-retention job runs it for every active tenant.
 *
 * Before deleting, it runs the reaper (TASK-193, trajectory-closure.ts): an open trajectory —
 * running, paused, awaiting_retry, indeterminate — with no activity for
 * `agent.trajectory.abandon_after_hours` and no open hold on its chain (a proposal proposed,
 * approved, executing or indeterminate) is ended `failed`, with a step saying so. A trajectory
 * waiting on a hold is never reaped: the hold's decision or expiry ends it (hold-expiry.ts). An
 * indeterminate one (an external effect never resolved, no hold) raises an alert as it is ended.
 * Reaped trajectories keep their last activity time, so retention counts from it. A workflow's
 * trajectory (its trigger a workflow goal) is the user's to continue, and is reaped only past
 * `agent.workflow.abandon_after_days` (30; review round 1, M1).
 *
 * getConfig is imported lazily, like budget-config.ts, so importing this into the agent graph at
 * boot does not load the config and data layers early.
 *
 * @module platform/agents
 */

import { getTrajectoryStore } from "./trajectory-store";
import { getProposalStore } from "./proposal-store";
import {
  OPEN_HOLD_STATUSES,
  resolveTrajectoryAbandonHours,
  resolveWorkflowAbandonDays,
  workflowTriggers,
} from "./trajectory-closure";
import { raiseAlert } from "@/platform/observability/alert";

export const TRAJECTORY_RETENTION_KEY = "agent.trajectory.retention_days";
/** The seeded default, used when the setting cannot be read or is not a sensible number. */
export const DEFAULT_TRAJECTORY_RETENTION_DAYS = 90;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
/** Deleted per run at most; a larger backlog continues in the next part of the job. */
export const TRAJECTORY_RETENTION_BATCH = 5000;
/** Ended per run at most by the reaper; a larger backlog continues in the next part. */
export const TRAJECTORY_REAP_BATCH = 1000;

/** The retention, in whole days: the tenant's value, else the platform default, clamped. */
export async function resolveTrajectoryRetentionDays(): Promise<number> {
  try {
    const { getConfig } = await import("@/platform/auth/platform-config");
    const v = Number(
      await getConfig<number>(TRAJECTORY_RETENTION_KEY, DEFAULT_TRAJECTORY_RETENTION_DAYS)
    );
    if (!Number.isFinite(v)) return DEFAULT_TRAJECTORY_RETENTION_DAYS;
    return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(v)));
  } catch {
    return DEFAULT_TRAJECTORY_RETENTION_DAYS;
  }
}

export interface TrajectoryRetentionResult {
  readonly retentionDays: number;
  readonly deleted: number;
  /** Open trajectories the reaper ended (no activity, no open hold). */
  readonly abandoned: number;
  readonly abandonHours: number;
  /** The workflow bound, in days (a workflow's trajectory is reaped only past it). */
  readonly workflowAbandonDays: number;
  /** A full batch was deleted or ended: there may be more. */
  readonly more: boolean;
}

/** The trajectory ids an open hold of the current tenant names (for the in-memory store). */
async function openHoldTrajectories(): Promise<ReadonlySet<string>> {
  const store = getProposalStore();
  const lists = await Promise.all(
    OPEN_HOLD_STATUSES.map((status) => store.query({ status }))
  );
  return new Set(lists.flat().map((p) => p.trajectoryId));
}

/**
 * End the current tenant's abandoned open trajectories, then delete its finished trajectories
 * older than its retention.
 *
 * @scheduled agents.trajectory-retention
 */
export async function applyTrajectoryRetention(
  now: Date = new Date(),
  batch: number = TRAJECTORY_RETENTION_BATCH
): Promise<TrajectoryRetentionResult> {
  const store = getTrajectoryStore();
  const abandonHours = await resolveTrajectoryAbandonHours();
  const workflowDays = await resolveWorkflowAbandonDays();
  const reaped = store.closeAbandoned
    ? await store.closeAbandoned(
        new Date(now.getTime() - abandonHours * 60 * 60_000),
        Math.min(batch, TRAJECTORY_REAP_BATCH),
        openHoldTrajectories,
        // A workflow's trajectory is the user's to continue: its own, longer bound (review
        // round 1, M1) — never shorter than the request bound.
        {
          triggers: await workflowTriggers(),
          cutoff: new Date(
            now.getTime() - Math.max(workflowDays * 24, abandonHours) * 60 * 60_000
          ),
        }
      )
    : { closed: 0, indeterminate: 0, segments: 0 };
  if (reaped.indeterminate > 0) {
    raiseAlert({
      name: "agents.indeterminate_reaped",
      message: `${reaped.indeterminate} indeterminate trajectory(ies) — an external effect never confirmed or denied, and no hold to decide it — were ended after ${abandonHours} hours without activity. Check the effect ledger for their operations (docs/runbooks/approvals-and-agents.md).`,
      count: reaped.indeterminate,
    });
  }
  const retentionDays = await resolveTrajectoryRetentionDays();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
  const deleted = await store.deleteFinishedBefore(cutoff, batch);
  return {
    retentionDays,
    deleted,
    abandoned: reaped.closed,
    abandonHours,
    workflowAbandonDays: workflowDays,
    more: deleted >= batch || reaped.closed >= Math.min(batch, TRAJECTORY_REAP_BATCH),
  };
}
