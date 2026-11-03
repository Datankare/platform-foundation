/**
 * platform/jobs/required-schedule.ts — a required job's `enabled` setting is never written off
 * (TASK-194 round 19, I-1)
 *
 * Its own module, read by the config store (platform/auth/platform-config.ts
 * setConfigWithHistory) and the config tools (platform/admin/config-handlers.ts): it loads the job
 * registry only for a job's `enabled` key, so neither imports the registry (which composes the
 * duties, which read config).
 *
 * @module platform/jobs
 */

import type { ConfigScope } from "@/platform/admin/types";

/** The `enabled` key of a recurring job (platform/jobs/registry.ts scheduleKeys). */
const SCHEDULE_ENABLED_KEY = /^jobs\.(.+)\.enabled$/;

/**
 * Whether a write of `value` to `key` at `scope` is refused because the key turns a required job
 * on (TASK-194 round 19, I-1). A required schedule always runs: the scheduler does not read its
 * setting (platform/jobs/runner.ts scheduleEnabled), so a row saying otherwise would misstate what
 * runs. Its `enabled` key takes only `true`, and only as the platform default — never a tenant's
 * own value. Answered `jobs.schedule_required` by every config write: the config tools before
 * anything is held or filed (config-handlers.ts), and the store's write itself
 * (setConfigWithHistory), so an approval filed before the job was required (migration 062) is
 * refused when approved too. `value` is as validated (a form's "false" is false).
 */
export async function refusesRequiredSchedule(
  key: string,
  value: unknown,
  scope: ConfigScope
): Promise<boolean> {
  const kind = SCHEDULE_ENABLED_KEY.exec(key)?.[1];
  if (!kind) return false;
  // Loaded when needed: the job registry composes the duties, which read config.
  const { getJobDefinition } = await import("@/platform/jobs/registry");
  if (getJobDefinition(kind)?.schedule?.required !== true) return false;
  return scope !== "platform" || value !== true;
}

/**
 * Why a change to a required job's enabled key is withdrawn by the system (round 20, nit 2; round
 * 21, nit 1: the body only — each caller says it was withdrawn its own way): one wording for every
 * row so withdrawn — a two-person approval's apply ("withdrawn by the system: …", config-approval
 * withdrawUnapplied), an approved runtime hold ("refused: …", approval-decision; the store adds
 * "withdrawn: ") and migration 062 ("withdrawn by the system: … (migration 062)") — true whatever
 * value the change asked for.
 */
export function requiredJobWithdrawalNote(key: string): string {
  return `"${key}" turns on a job that is now required — always on, and set only as the platform default`;
}
