/**
 * platform/jobs/registry.ts — which job kinds exist (ADR-056 D2, ADR-054 D4)
 *
 * One list, composed like the other extensible registries: the core's duties
 * (./duties.ts), then each registered module's `jobs` in registration order, then the app's own
 * (registerJob, at boot). A kind is declared once — a second declaration anywhere is refused,
 * naming both owners — and validated where it is declared, so a malformed one fails boot, not a
 * tick.
 *
 * @module platform/jobs
 */

import { getSingleton } from "@/platform/kernel/singleton";
import { composeWithModules } from "@/platform/modules/compose";
import { checkBackoff, DEFAULT_BACKOFF } from "./backoff";
import { CORE_JOBS } from "./duties";
import type {
  JobDefinition,
  JobHandler,
  JobKind,
  JobOptions,
  JobSchedule,
  ResolvedJobDefinition,
} from "./types";

/** dotted lower-case words, the first naming the owning area (the 050 jobs_kind_shape check). */
export const JOB_KIND = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

const KIND_SEGMENT = /^[a-z][a-z0-9-]*$/;
const KEY_HEAD = /^[a-z][a-z0-9_]*$/;
const KEY_SEGMENT = /^[a-z][a-z0-9_-]*$/;

/**
 * Whether `value` is a job kind (JOB_KIND, at most 100 characters). Checked a segment at a time,
 * so the test is linear in the input whatever it holds.
 */
export function isJobKind(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  const parts = value.split(".");
  return parts.length >= 2 && parts.every((p) => KIND_SEGMENT.test(p));
}

/** Whether `value` is a governed setting key (a dotted name, at most 200 characters). */
function isSettingKey(value: string): boolean {
  if (value.length > 200) return false;
  const [head, ...rest] = value.split(".");
  return (
    KEY_HEAD.test(head) && rest.length >= 1 && rest.every((p) => KEY_SEGMENT.test(p))
  );
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_TIMEOUT_MS = 25_000;
/** The longest attempt a kind may declare: five minutes (a tick's whole budget is less). */
export const MAX_TIMEOUT_MS = 5 * 60_000;
/** The longest interval a schedule may have: a week. */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** A malformed or colliding job declaration. */
export class JobDefinitionError extends Error {
  constructor(kind: string, problem: string) {
    super(`Job "${kind}": ${problem} (ADR-056)`);
    this.name = "JobDefinitionError";
  }
}

function checkSchedule(kind: string, schedule: JobSchedule): JobSchedule {
  const { scope, defaultIntervalMinutes: d, minIntervalMinutes: lo } = schedule;
  const hi = schedule.maxIntervalMinutes;
  if (scope !== "platform" && scope !== "each-tenant") {
    throw new JobDefinitionError(kind, "a schedule's scope is platform or each-tenant");
  }
  const whole = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_INTERVAL_MINUTES;
  if (!whole(lo) || !whole(hi) || !whole(d) || lo > d || d > hi) {
    throw new JobDefinitionError(
      kind,
      `a schedule needs whole minutes min ≤ default ≤ max, within 1–${MAX_INTERVAL_MINUTES}`
    );
  }
  if (schedule.tenantOptOutKey !== undefined) {
    if (scope !== "each-tenant") {
      throw new JobDefinitionError(
        kind,
        "only a per-tenant schedule has a tenant opt-out"
      );
    }
    if (!isSettingKey(schedule.tenantOptOutKey)) {
      throw new JobDefinitionError(kind, "the tenant opt-out is not a setting key");
    }
  }
  return Object.freeze({ ...schedule });
}

/** Validate a declaration and apply its defaults. Throws JobDefinitionError. */
export function defineJob(
  kind: JobKind,
  handler: JobHandler,
  options: JobOptions
): ResolvedJobDefinition {
  if (!isJobKind(kind)) {
    throw new JobDefinitionError(
      String(kind),
      "the kind must be dotted lower-case words"
    );
  }
  if (typeof handler !== "function") throw new JobDefinitionError(kind, "no handler");
  if (typeof options?.description !== "string" || options.description.trim() === "") {
    throw new JobDefinitionError(kind, "a description is required");
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 25) {
    throw new JobDefinitionError(kind, "maxAttempts must be 1–25");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new JobDefinitionError(kind, "timeoutMs must be 1 s – 5 min");
  }
  let backoff;
  try {
    backoff = checkBackoff(options.backoff ?? DEFAULT_BACKOFF);
  } catch (err) {
    throw new JobDefinitionError(kind, (err as Error).message);
  }
  const schedule = options.schedule ? checkSchedule(kind, options.schedule) : undefined;
  if (
    options.scope !== undefined &&
    options.scope !== "platform" &&
    options.scope !== "each-tenant"
  ) {
    throw new JobDefinitionError(kind, "scope is platform or each-tenant");
  }
  if (schedule && options.scope !== undefined && options.scope !== schedule.scope) {
    throw new JobDefinitionError(
      kind,
      `scope "${options.scope}" differs from its schedule's "${schedule.scope}"`
    );
  }
  const scope = schedule?.scope ?? options.scope ?? "each-tenant";
  const runsForSuspended = options.runsForSuspended ?? false;
  if (typeof runsForSuspended !== "boolean") {
    throw new JobDefinitionError(kind, "runsForSuspended is true or false");
  }
  if (runsForSuspended && scope !== "each-tenant") {
    throw new JobDefinitionError(
      kind,
      "only a per-tenant kind runs for suspended tenants (a platform job has no tenant)"
    );
  }
  return Object.freeze({
    kind,
    handler,
    description: options.description.trim(),
    maxAttempts,
    timeoutMs,
    backoff,
    scope,
    runsForSuspended,
    ...(schedule ? { schedule } : {}),
  });
}

/** A module's or the core's declaration, validated. */
export function resolveDefinition(def: JobDefinition): ResolvedJobDefinition {
  return defineJob(def.kind, def.handler, def);
}

interface AppJobs {
  readonly byKind: Map<JobKind, ResolvedJobDefinition>;
}

const APP_JOBS_KEY = "platform.jobs.appRegistry";
const appJobs = (): AppJobs =>
  getSingleton<AppJobs>(APP_JOBS_KEY, () => ({ byKind: new Map() }));

/** The core's and the registered modules' kinds, with their owners (memoized per module set). */
function composed(): readonly { moduleId: string; value: ResolvedJobDefinition }[] {
  return composeWithModules(
    "job",
    CORE_JOBS.map(resolveDefinition),
    (d) => d.kind,
    (m) => m.jobs.map(resolveDefinition)
  );
}

/**
 * Add a job kind of the app's own. Called at boot (an app's instrumentation, after its modules
 * are registered). Refuses a kind the core, a module or an earlier call declared. Returns the
 * resolved declaration.
 */
export function registerJob(
  kind: JobKind,
  handler: JobHandler,
  options: JobOptions
): ResolvedJobDefinition {
  const def = defineJob(kind, handler, options);
  const owner = composed().find((c) => c.value.kind === kind);
  if (owner) {
    const by = owner.moduleId === "core" ? "the core" : `module "${owner.moduleId}"`;
    throw new JobDefinitionError(kind, `already declared by ${by}`);
  }
  const app = appJobs().byKind;
  if (app.has(kind)) throw new JobDefinitionError(kind, "already registered");
  app.set(kind, def);
  return def;
}

/** Every job kind: the core's, the modules', then the app's. */
export function listJobDefinitions(): readonly ResolvedJobDefinition[] {
  const base = composed().map((c) => c.value);
  const app = [...appJobs().byKind.values()].filter(
    (d) => !base.some((b) => b.kind === d.kind)
  );
  return [...base, ...app];
}

/** Who declared each kind: "core", a module id, or "app". */
export function listJobOwners(): readonly { kind: JobKind; owner: string }[] {
  return [
    ...composed().map((c) => ({ kind: c.value.kind, owner: c.moduleId })),
    ...[...appJobs().byKind.keys()].map((kind) => ({ kind, owner: "app" })),
  ];
}

export function getJobDefinition(kind: JobKind): ResolvedJobDefinition | undefined {
  return listJobDefinitions().find((d) => d.kind === kind);
}

/** The recurring kinds. */
export function listScheduledJobs(): readonly (ResolvedJobDefinition & {
  readonly schedule: JobSchedule;
})[] {
  return listJobDefinitions().filter(
    (d): d is ResolvedJobDefinition & { schedule: JobSchedule } =>
      d.schedule !== undefined
  );
}

/** The governed settings of a recurring kind (seeded by a migration, ADR-056 D3). */
export function scheduleKeys(kind: JobKind): {
  readonly enabled: string;
  readonly interval: string;
} {
  return { enabled: `jobs.${kind}.enabled`, interval: `jobs.${kind}.interval_minutes` };
}

/** Forget the app's registrations (tests only). */
export function resetJobRegistry(): void {
  appJobs().byKind.clear();
}
