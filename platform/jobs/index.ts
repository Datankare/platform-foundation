/**
 * platform/jobs — durable background work: a Postgres-backed queue, a scheduler, and the timed
 * duties as recurring jobs (ADR-056 D2, D3)
 *
 *   registerJob(kind, handler, options)   an app's own job kind (modules declare `jobs`)
 *   enqueueJob(kind, { idempotencyKey })  put work on the queue, idempotently, for the current
 *                                         tenant (another, or a platform job: a JobAuthority)
 *   runDue({ budgetMs })                  what a host tick does: schedule, claim, run, settle
 *   requireJobTick(request)               the tick route's verifier (CRON_SECRET)
 *
 * The store is a provider slot (JOB_STORE): Postgres (migration 050) in production, in memory for
 * tests and local runs. How to operate it: docs/runbooks/jobs.md.
 *
 * @module platform/jobs
 */

export { DEFAULT_BACKOFF, checkBackoff, retryDelayMs } from "./backoff";
export {
  JobFailure,
  JobTimeoutError,
  MAX_ERROR_LENGTH,
  describeJobError,
} from "./errors";
export {
  JOB_KIND,
  JobDefinitionError,
  isJobKind,
  defineJob,
  getJobDefinition,
  listJobDefinitions,
  listJobOwners,
  listScheduledJobs,
  registerJob,
  resetJobRegistry,
  scheduleKeys,
} from "./registry";
export {
  JobEnqueueError,
  MAX_PAYLOAD_BYTES,
  enqueueJob,
  type EnqueueOptions,
} from "./queue";
export {
  CLAIM_BATCH,
  HUNG_WAIT_MS,
  LEASE_GRACE_MS,
  MAX_BUDGET_MS,
  MAX_HUNG_MS,
  hungJobCount,
  newWorkerId,
  platformHomeTenant,
  runDue,
  settleHungJobs,
  type RunDueOptions,
  type RunDueReport,
} from "./runner";
export { OPERATOR_PERMISSION, isJobAuthority, operatorJobAuthority } from "./authority";
export {
  JobTickFitError,
  SETTLE_MARGIN_MS,
  TICK_BUDGET_MS,
  TICK_MAX_TIMEOUT_MS,
  checkJobsFitTick,
  jobsThatDoNotFitTick,
} from "./tick";
export {
  STALE_SCHEDULE_GRACE_MS,
  createScheduleFreshnessProbe,
  staleSchedules,
} from "./schedule-probe";
export { getJobStore, resetJobStore, setJobStore, JOB_STORE_KEY } from "./store";
export { InMemoryJobStore, type MemoryJobStoreOptions } from "./memory-store";
export { PostgresJobStore } from "./postgres-store";
export { requireJobTick, tickHeaderMatches, MIN_SECRET_LENGTH } from "./tick-auth";
export {
  RUN_NOW_BUDGET_MS,
  describeSchedules,
  discardDeadJob,
  listDeadLetters,
  listTenantJobHistory,
  replayDeadJob,
  runNow,
  setSchedule,
  type JobsFailure,
  type JobsResult,
  type RunNowResult,
  type ScheduleChange,
  type ScheduleChangeOutcome,
  type ScheduleView,
} from "./operator";
export type * from "./types";
