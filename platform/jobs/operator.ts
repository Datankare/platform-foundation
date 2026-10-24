/**
 * platform/jobs/operator.ts — what operators do with jobs (ADR-056 D2, D3)
 *
 * The Jobs console (components/admin/JobsPanels.tsx) through /api/operator/jobs/**, which verify
 * platform_operate. Every action is recorded in the audit log before it takes effect (no record,
 * no change — audit X-8), in the operator's own tenant, naming the job or kind acted on:
 *
 *   schedules      each recurring kind with its governed settings and runtime state
 *   setSchedule    turn a schedule on or off, or change its interval — a governed config change
 *                  (writeGovernedConfig: tier permission, audit, history, two-person approval and
 *                  dual control apply exactly as on the config page)
 *   runNow         enqueue the kind now — one statement for every tenant it runs for, or the
 *                  platform — and run what fits in a short budget; the rest runs on the next
 *                  tick. A second audit record says what happened (how many were enqueued,
 *                  run, retried, dead-lettered)
 *   dead letters   list, replay (from the first attempt), discard
 *
 * Errors carry codes only; a job's last_error is already the platform's own wording.
 *
 * @module platform/jobs
 */

import { randomUUID } from "node:crypto";
import { audited, AuditWriteError, writeAuditLog } from "@/platform/auth/audit";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import {
  writeGovernedConfig,
  type GovernedConfigOutcome,
} from "@/platform/admin/governed-config";
import { getTenancySettings } from "@/platform/providers/environment-contract";
import { runWithoutTenant } from "@/platform/tenancy/context";
import { runDue, scheduleEnabled, scheduleInterval, type RunDueReport } from "./runner";
import {
  getJobDefinition,
  listJobOwners,
  listScheduledJobs,
  scheduleKeys,
} from "./registry";
import { getJobStore } from "./store";
import type { JobRecord, JobScope, ScheduleState } from "./types";

/** How long an operator's "run now" may run inside the request; the rest waits for a tick. */
export const RUN_NOW_BUDGET_MS = 45_000;

export type JobsFailure = "jobs.not_found" | "jobs.not_dead" | "audit.unavailable";

export type JobsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: JobsFailure };

const ok = <T>(value: T): JobsResult<T> => ({ ok: true, value });
const fail = <T>(code: JobsFailure): JobsResult<T> => ({ ok: false, code });

export interface ScheduleView {
  readonly kind: string;
  readonly description: string;
  /** "core", a module id, or "app". */
  readonly owner: string;
  readonly scope: JobScope;
  /** Runs for suspended tenants too (a legal obligation). */
  readonly runsForSuspended: boolean;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly minIntervalMinutes: number;
  readonly maxIntervalMinutes: number;
  readonly tenantOptOutKey: string | null;
  readonly settings: { readonly enabled: string; readonly interval: string };
  /**
   * Never run yet: null. nextRunAt is when the scheduler will take the next slot under the
   * interval in force now (a shortened interval brings it forward at once).
   */
  readonly state: ScheduleState | null;
}

/** Every recurring kind, as the scheduler sees it (the platform's settings). */
export async function describeSchedules(): Promise<ScheduleView[]> {
  const states = new Map((await getJobStore().listSchedules()).map((s) => [s.kind, s]));
  const owners = new Map(listJobOwners().map((o) => [o.kind, o.owner]));
  return runWithoutTenant(async () => {
    const out: ScheduleView[] = [];
    for (const def of listScheduledJobs()) {
      const intervalMinutes = await scheduleInterval(def);
      const state = states.get(def.kind) ?? null;
      out.push({
        kind: def.kind,
        description: def.description,
        owner: owners.get(def.kind) ?? "core",
        scope: def.schedule.scope,
        runsForSuspended: def.runsForSuspended,
        enabled: await scheduleEnabled(def.kind),
        intervalMinutes,
        minIntervalMinutes: def.schedule.minIntervalMinutes,
        maxIntervalMinutes: def.schedule.maxIntervalMinutes,
        tenantOptOutKey: def.schedule.tenantOptOutKey ?? null,
        settings: scheduleKeys(def.kind),
        state: state && { ...state, nextRunAt: effectiveNextRun(state, intervalMinutes) },
      });
    }
    return out;
  });
}

/** The earlier of the recorded next slot and the last run plus the interval in force now. */
function effectiveNextRun(state: ScheduleState, intervalMinutes: number): string | null {
  if (!state.nextRunAt || !state.lastRunAt) return state.nextRunAt;
  const byInterval = Date.parse(state.lastRunAt) + intervalMinutes * 60_000;
  return byInterval < Date.parse(state.nextRunAt)
    ? new Date(byInterval).toISOString()
    : state.nextRunAt;
}

/** Dead-lettered jobs, newest first. */
export function listDeadLetters(limit = 100): Promise<JobRecord[]> {
  return getJobStore().listJobs({ status: "dead", limit });
}

export interface ScheduleChange {
  readonly enabled?: boolean;
  readonly intervalMinutes?: number;
  readonly changeComment: string;
}

/** Each setting changed, and how (applied, held for a second operator, refused, invalid…). */
export type ScheduleChangeOutcome = readonly {
  readonly key: string;
  readonly outcome: GovernedConfigOutcome;
}[];

/**
 * Change a schedule's governed settings as `admin`. Unknown or non-recurring kind: not found.
 * Each setting goes through writeGovernedConfig, which decides and records it.
 */
export async function setSchedule(
  admin: VerifiedAdmin,
  kind: string,
  change: ScheduleChange
): Promise<JobsResult<ScheduleChangeOutcome>> {
  const def = getJobDefinition(kind);
  if (!def?.schedule) return fail("jobs.not_found");
  const keys = scheduleKeys(kind);
  const writes: { key: string; value: unknown }[] = [];
  if (change.enabled !== undefined)
    writes.push({ key: keys.enabled, value: change.enabled });
  if (change.intervalMinutes !== undefined) {
    writes.push({ key: keys.interval, value: change.intervalMinutes });
  }
  const out: { key: string; outcome: GovernedConfigOutcome }[] = [];
  for (const w of writes) {
    out.push({
      key: w.key,
      outcome: await writeGovernedConfig(admin, {
        key: w.key,
        value: w.value,
        changeComment: change.changeComment,
        scope: "platform",
      }),
    });
  }
  return ok(out);
}

export interface RunNowResult {
  readonly enqueued: number;
  readonly report: RunDueReport;
}

/**
 * Enqueue a recurring kind now — for every tenant it runs for (one tenant in a dedicated
 * deployment), or once for the platform, in one statement — and run what fits in
 * RUN_NOW_BUDGET_MS. Recorded first; a second record says what actually happened.
 */
export async function runNow(
  admin: VerifiedAdmin,
  kind: string
): Promise<JobsResult<RunNowResult>> {
  const def = getJobDefinition(kind);
  if (!def?.schedule) return fail("jobs.not_found");
  const store = getJobStore();
  const entry = {
    action: "admin_action" as const,
    actorId: admin.userId,
    details: { type: "job_run_now", kind },
  };
  try {
    return await audited(entry, async () => {
      const tenancy = getTenancySettings();
      const enqueued = await store.fanOut({
        kind,
        scope: def.scope,
        idempotencyKey: `manual:${randomUUID()}`,
        maxAttempts: def.maxAttempts,
        source: "manual",
        runsForSuspended: def.runsForSuspended,
        ...(def.scope === "each-tenant" && tenancy.mode === "single"
          ? { tenantIds: [tenancy.tenantId] }
          : {}),
      });
      const report = await runDue({
        budgetMs: RUN_NOW_BUDGET_MS,
        kinds: [kind],
        schedule: false,
      });
      // What happened, beside the attempt record: none enqueued is an outcome too.
      await writeAuditLog({
        ...entry,
        details: {
          ...entry.details,
          outcome: "completed",
          enqueued,
          claimed: report.claimed,
          succeeded: report.succeeded,
          retried: report.retried,
          dead: report.dead,
          released: report.released,
          hung: report.hung,
          stoppedBy: report.stoppedBy,
        },
      });
      return ok({ enqueued, report });
    });
  } catch (err) {
    if (err instanceof AuditWriteError) return fail("audit.unavailable");
    throw err;
  }
}

type DeadJobOutcome = "done" | "not_found" | "not_dead";

/** Check the job is dead, record the action, then act (no record, no change). */
async function onDeadJob(
  admin: VerifiedAdmin,
  type: "job_replayed" | "job_discarded",
  id: string,
  act: () => Promise<DeadJobOutcome>
): Promise<JobsResult<{ readonly id: string; readonly kind: string }>> {
  const job = await getJobStore().getJob(id);
  if (!job) return fail("jobs.not_found");
  if (job.status !== "dead") return fail("jobs.not_dead");
  try {
    const outcome = await audited(
      {
        action: "admin_action",
        actorId: admin.userId,
        details: { type, jobId: id, kind: job.kind, tenantId: job.tenantId },
      },
      async () => {
        const r = await act();
        return r === "done"
          ? { success: true as const, r }
          : { success: false as const, error: r, r };
      }
    );
    if (outcome.r === "done") return ok({ id, kind: job.kind });
    // Another operator acted between the check and the change.
    return fail(outcome.r === "not_dead" ? "jobs.not_dead" : "jobs.not_found");
  } catch (err) {
    if (err instanceof AuditWriteError) return fail("audit.unavailable");
    throw err;
  }
}

/** Queue a dead job again from its first attempt. A second replay finds it not dead. */
export function replayDeadJob(
  admin: VerifiedAdmin,
  id: string
): Promise<JobsResult<{ readonly id: string; readonly kind: string }>> {
  return onDeadJob(admin, "job_replayed", id, async () => {
    const r = await getJobStore().replay(id);
    return r === "replayed" ? "done" : r;
  });
}

/** Remove a dead job for good. */
export function discardDeadJob(
  admin: VerifiedAdmin,
  id: string
): Promise<JobsResult<{ readonly id: string; readonly kind: string }>> {
  return onDeadJob(admin, "job_discarded", id, async () => {
    const r = await getJobStore().discard(id);
    return r === "discarded" ? "done" : r;
  });
}

/** The current tenant's own jobs, newest first — its administrators' read-only history. */
export function listTenantJobHistory(limit = 50): Promise<JobRecord[]> {
  return getJobStore().listTenantJobs({ limit });
}
