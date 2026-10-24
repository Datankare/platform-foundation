/**
 * platform/agents/trajectory-retention.ts — finished trajectories are kept for a governed time
 *
 * `agent.trajectory.retention_days` (migration 016, tenant settable) says how long a completed
 * or failed trajectory is kept; nothing enforced it (TASK-141). applyTrajectoryRetention deletes
 * the current tenant's finished trajectories older than that, a bounded batch per run; the
 * agents.trajectory-retention job runs it for every active tenant. Running, paused and
 * indeterminate trajectories are never deleted: a held action may still resume them.
 *
 * getConfig is imported lazily, like budget-config.ts, so importing this into the agent graph at
 * boot does not load the config and data layers early.
 *
 * @module platform/agents
 */

import { getTrajectoryStore } from "./trajectory-store";

export const TRAJECTORY_RETENTION_KEY = "agent.trajectory.retention_days";
/** The seeded default, used when the setting cannot be read or is not a sensible number. */
export const DEFAULT_TRAJECTORY_RETENTION_DAYS = 90;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
/** Deleted per run at most; a larger backlog continues in the next part of the job. */
export const TRAJECTORY_RETENTION_BATCH = 5000;

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
  /** A full batch was deleted: there may be more. */
  readonly more: boolean;
}

/**
 * Delete the current tenant's finished trajectories older than its retention.
 *
 * @scheduled agents.trajectory-retention
 */
export async function applyTrajectoryRetention(
  now: Date = new Date(),
  batch: number = TRAJECTORY_RETENTION_BATCH
): Promise<TrajectoryRetentionResult> {
  const retentionDays = await resolveTrajectoryRetentionDays();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
  const deleted = await getTrajectoryStore().deleteFinishedBefore(cutoff, batch);
  return { retentionDays, deleted, more: deleted >= batch };
}
