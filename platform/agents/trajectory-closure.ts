/**
 * platform/agents/trajectory-closure.ts — every trajectory that is opened is ended (TASK-193)
 *
 * A trajectory is created `running`; nothing in the store ends it. invokeTool records steps and
 * never sets a status, so every caller that opened a trajectory for one request — the command
 * bar, the Users and Entitlements pages' held changes, every governed config write — left it
 * `running` for good, out of reach of agent.trajectory.retention_days, which deletes only
 * completed and failed ones (audit B-1, A-1). On playform-dev five command-bar trajectories were
 * stuck that way.
 *
 * Two parts:
 *
 *   - withTrajectory / finishTrajectory: the code that opens a trajectory for one request ends it
 *     when the request ends — completed or failed — from `running` only (compare-and-set). A
 *     trajectory the request left waiting on a hold (`paused` by proposeAction) is the hold's to
 *     end: its decision, its withdrawal or its expiry (endHeldTrajectory, hold-expiry.ts).
 *     __tests__/lifecycle-closure-scan.test.ts reads every TrajectoryStore.create, createSession
 *     and proposeOnce call site and fails unless it is inside withTrajectory or names its closer.
 *   - the reaper (TrajectoryStore.closeAbandoned, run by the agents.trajectory-retention job
 *     before it deletes): any open trajectory with no activity for agent.trajectory.abandon_after_hours
 *     and no open hold on its chain (and not an app session's, whose session owns it — audit B-5)
 *     is ended `failed`, with a step saying so — a crashed request,
 *     a serverless timeout, a budget or step-cap pause nothing resumes (B-3), a workflow whose hold
 *     was decided elsewhere (B-2), and the records left before this change. It is what closes the
 *     stuck ones already in a database, through the app's own job, never a hand edit.
 *
 * A workflow's trajectory (its trigger is a workflow goal: ADR-029 D8, workflow-loop.ts) is the
 * user's to continue — after a step-cap or budget pause, or after an approved step — for as long
 * as they come back, so the 24-hour bound is not its (review round 1, M1). Its own lifecycle ends
 * it: its holds' decisions and expiry, then workflow retention. The reaper reaches it only past
 * the separate, much longer agent.workflow.abandon_after_days (30, 1–365): a workflow nobody has
 * touched for a month is ended `failed` like any other. A hold's executed decision does not
 * complete it either (settleHeldTrajectory): the workflow continues past the held step.
 *
 * @module platform/agents
 */

import type {
  TrajectoryRecord,
  TrajectoryStatus,
  TrajectoryStore,
  TrajectorySubject,
} from "@/platform/kernel/types";
import { getTrajectoryStore } from "./trajectory-store";
import { logger } from "@/lib/logger";

/** Statuses of a trajectory that is not over. */
export const OPEN_TRAJECTORY_STATUSES: readonly TrajectoryStatus[] = [
  "running",
  "paused",
  "awaiting_retry",
  "indeterminate",
];

/** Statuses of a trajectory that is over: kept for agent.trajectory.retention_days, then deleted. */
export const FINISHED_TRAJECTORY_STATUSES: readonly TrajectoryStatus[] = [
  "completed",
  "failed",
];

/** The proposal statuses that hold a trajectory open: a decision, a run or a person is awaited. */
export const OPEN_HOLD_STATUSES = [
  "proposed",
  "approved",
  "executing",
  "indeterminate",
] as const;

/** How a request's trajectory ends. */
export type TrajectoryOutcome = "completed" | "failed";

/**
 * End `trajectoryId` as `outcome` — only while it is `running`: one the request left waiting on a
 * hold (paused) is the hold's to end, and one a concurrent run already ended stays as it is. Best
 * effort: a store that cannot be written is logged, and the reaper ends the trajectory later.
 */
export async function finishTrajectory(
  store: TrajectoryStore,
  trajectoryId: string,
  outcome: TrajectoryOutcome
): Promise<void> {
  try {
    if (store.supportsStatusCas) {
      await store.updateStatus(trajectoryId, outcome, { from: ["running"] });
      return;
    }
    // A store without compare-and-set: read, then write (a race only delays the end to the reaper).
    const current = await store.getById(trajectoryId);
    if (current?.trajectory.status === "running") {
      await store.updateStatus(trajectoryId, outcome);
    }
  } catch (err) {
    logger.warn(
      "A trajectory could not be ended; the retention job's reaper will end it",
      {
        trajectoryId,
        outcome,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/agents/trajectory-closure",
      }
    );
  }
}

export interface WithTrajectoryArgs {
  readonly subject: TrajectorySubject;
  readonly trigger: string;
  readonly scopeType: "group" | "user" | "platform";
  readonly scopeId?: string;
  readonly store?: TrajectoryStore;
}

/**
 * Open a trajectory, run `run` in it, and end it: `outcome(result)` (completed by default) when
 * `run` returns, failed when it throws — from `running` only (finishTrajectory). The one way code
 * that opens a trajectory for a request is allowed to (lifecycle-closure-scan).
 */
export async function withTrajectory<T>(
  args: WithTrajectoryArgs,
  run: (trajectoryId: string, record: TrajectoryRecord) => Promise<T>,
  outcome: (result: T) => TrajectoryOutcome = () => "completed"
): Promise<T> {
  const store = args.store ?? getTrajectoryStore();
  const record = await store.create(
    args.subject,
    args.trigger,
    args.scopeType,
    args.scopeId
  );
  const trajectoryId = record.trajectory.trajectoryId;
  let ended: TrajectoryOutcome = "failed";
  try {
    const result = await run(trajectoryId, record);
    ended = outcome(result);
    return result;
  } finally {
    await finishTrajectory(store, trajectoryId, ended);
  }
}

/** The governed bound on an open trajectory with no activity and no open hold. */
export const TRAJECTORY_ABANDON_KEY = "agent.trajectory.abandon_after_hours";
export const DEFAULT_TRAJECTORY_ABANDON_HOURS = 24;
const MIN_HOURS = 1;
const MAX_HOURS = 720;

/** The bound, in whole hours: the tenant's value, else the platform default, clamped. */
export async function resolveTrajectoryAbandonHours(): Promise<number> {
  try {
    const { getConfig } = await import("@/platform/auth/platform-config");
    const v = Number(
      await getConfig<number>(TRAJECTORY_ABANDON_KEY, DEFAULT_TRAJECTORY_ABANDON_HOURS)
    );
    if (!Number.isFinite(v)) return DEFAULT_TRAJECTORY_ABANDON_HOURS;
    return Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.floor(v)));
  } catch {
    return DEFAULT_TRAJECTORY_ABANDON_HOURS;
  }
}

/**
 * The bound on a workflow's open trajectory (review round 1, M1): far longer than the request
 * bound, because a person continues a workflow when they come back to it.
 */
export const WORKFLOW_ABANDON_KEY = "agent.workflow.abandon_after_days";
export const DEFAULT_WORKFLOW_ABANDON_DAYS = 30;
const MIN_WORKFLOW_DAYS = 1;
const MAX_WORKFLOW_DAYS = 365;

/** The workflow bound, in whole days: the tenant's value, else the platform default, clamped. */
export async function resolveWorkflowAbandonDays(): Promise<number> {
  try {
    const { getConfig } = await import("@/platform/auth/platform-config");
    const v = Number(
      await getConfig<number>(WORKFLOW_ABANDON_KEY, DEFAULT_WORKFLOW_ABANDON_DAYS)
    );
    if (!Number.isFinite(v)) return DEFAULT_WORKFLOW_ABANDON_DAYS;
    return Math.min(MAX_WORKFLOW_DAYS, Math.max(MIN_WORKFLOW_DAYS, Math.floor(v)));
  } catch {
    return DEFAULT_WORKFLOW_ABANDON_DAYS;
  }
}

/**
 * The triggers a workflow's trajectory carries: every goal the core and the registered modules
 * declare (workflow-loop.ts creates a workflow's trajectory with its goal as the trigger).
 * Imported lazily: goals.ts composes the module registry.
 */
export async function workflowTriggers(): Promise<readonly string[]> {
  const { listAgentGoals } = await import("./goals");
  return listAgentGoals();
}

/** Whether `record` is a workflow's trajectory (its trigger is a declared workflow goal). */
export async function isWorkflowTrajectory(
  record: Pick<TrajectoryRecord, "trigger"> | undefined
): Promise<boolean> {
  if (!record) return false;
  return (await workflowTriggers()).includes(record.trigger);
}

export { REAPED_ACTION } from "./trajectory-store";
