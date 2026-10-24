/**
 * platform/jobs/types.ts — the shapes of background work (ADR-056 D2, D3)
 *
 * Type-only, a leaf: the module types (platform/modules/types.ts) import it so a module can
 * contribute jobs without a cycle.
 *
 * @module platform/jobs
 */

/** A job kind: dotted lower-case words, the first naming the owning area — "moderation.expire-strikes". */
export type JobKind = string;

/** Where a job came from: a schedule's slot, an operator's "run now", a replay, or code. */
export type JobSource = "enqueue" | "schedule" | "manual" | "replay";

/**
 * parked: queued for a tenant that is not active (suspended, or deleted and awaiting its purge),
 * kept out of the claim until the tenant is active again (migration 050's tenant trigger); a kind
 * declared `runsForSuspended` is never parked for a suspended tenant.
 */
export type JobStatus = "queued" | "running" | "succeeded" | "dead" | "parked";

/**
 * Who a recurring job runs for: once for the platform (tenant purge, cross-tenant housekeeping),
 * or once for every active tenant, each in that tenant's context.
 */
export type JobScope = "platform" | "each-tenant";

/**
 * A recurring job's schedule. Its enabled flag and interval are governed configuration —
 * `jobs.<kind>.enabled` and `jobs.<kind>.interval_minutes`, seeded by a migration — so changing
 * either is audited, kept in history and, for the safety duties, dual-controlled. The values here
 * are what the scheduler uses when the configuration cannot be read; they must equal the seeds
 * (__tests__/jobs-scheduled-coverage.test.ts).
 */
export interface JobSchedule {
  readonly scope: JobScope;
  /** The interval when its setting cannot be read, in minutes. */
  readonly defaultIntervalMinutes: number;
  /** The bounds the setting is clamped to (the seed's min_value and max_value). */
  readonly minIntervalMinutes: number;
  readonly maxIntervalMinutes: number;
  /**
   * A boolean setting a tenant's own administrators may change (tenant settable) that turns this
   * job off for their tenant. Read in the tenant's context before each scheduled run.
   */
  readonly tenantOptOutKey?: string;
}

/** Retry timing: exponential from baseMs, capped at maxMs, with jitter (./backoff.ts). */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

/** What a handler is given for one attempt. */
export interface JobContext {
  readonly jobId: string;
  readonly kind: JobKind;
  /**
   * The tenant the job is for, or null for a platform job. A tenant job runs inside that tenant's
   * context (every store and withTenantTx read it); a platform job runs from the platform's home
   * tenant — the one operators act from — so its audit records are where operators' are, and it
   * reaches other tenants only through the owner connection.
   */
  readonly tenantId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** 1 on the first attempt. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly source: JobSource;
  /** Aborted when the attempt's time is up: stop, and return or throw. */
  readonly signal: AbortSignal;
  /** When the attempt's time is up (epoch ms). Work that would run past it should stop first. */
  readonly deadline: number;
  /** The name audit records carry for this job's actions: "job:<kind>". */
  readonly agent: string;
  /**
   * A platform job's right to enqueue work for any tenant or the platform (./authority.ts);
   * null for a tenant's job, which may enqueue for its own tenant only.
   */
  readonly authority: JobAuthority | null;
}

/**
 * The capability to enqueue a job for a tenant other than the current one, or a platform job
 * (./authority.ts). Minted only for the runner (a platform job's handler) and for a verified
 * operator; a forged object is refused.
 */
export interface JobAuthority {
  /** Who holds it: "runner" or "operator:<user id>" — for the log. */
  readonly holder: string;
}

/** What a handler may report. Counts go to the log; `continueWith` queues the next part. */
export interface JobResult {
  /** Small numbers or flags for the log line, e.g. { expired: 3 }. */
  readonly summary?: Readonly<Record<string, number | string | boolean>>;
  /**
   * The work did not fit in one attempt: enqueue the same kind again, for the same tenant, with
   * this payload (a cursor), to run as soon as a worker is free.
   */
  readonly continueWith?: Readonly<Record<string, unknown>>;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult | void>;

/** How a job kind runs. Every field but the description has a default. */
export interface JobOptions {
  /** One sentence for operators: what it does. */
  readonly description: string;
  /** Attempts before the job is dead-lettered (1–25, default 5). */
  readonly maxAttempts?: number;
  /** The time one attempt may take (1 s – 5 min, default 25 s). */
  readonly timeoutMs?: number;
  readonly backoff?: BackoffPolicy;
  /** Present for a recurring job. */
  readonly schedule?: JobSchedule;
  /**
   * Who the kind's jobs are for: each tenant (default) or the platform. A recurring kind's scope
   * is its schedule's; set both and they must agree. enqueueJob refuses a platform kind for a
   * tenant and a tenant kind as a platform job.
   */
  readonly scope?: JobScope;
  /**
   * The kind is a legal obligation that does not pause while its tenant is suspended — the GDPR
   * retention purge: its jobs are claimed, and its schedule reaches, suspended tenants too. A
   * deleted tenant's jobs never run (its purge removes everything). Per-tenant kinds only.
   */
  readonly runsForSuspended?: boolean;
}

/** A registered job kind. */
export interface JobDefinition extends JobOptions {
  readonly kind: JobKind;
  readonly handler: JobHandler;
}

/** A definition with its defaults applied. */
export interface ResolvedJobDefinition extends JobDefinition {
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly backoff: BackoffPolicy;
  readonly scope: JobScope;
  readonly runsForSuspended: boolean;
}

// ── The store ──────────────────────────────────────────────────────────

export interface EnqueueRequest {
  /** The tenant, or null for a platform job. */
  readonly tenantId: string | null;
  readonly kind: JobKind;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Unique per tenant and kind: a second enqueue with the same key is the same job. */
  readonly idempotencyKey: string;
  /** Not before this time; a time in the past is clamped to now (no queue-jumping). */
  readonly runAt?: Date;
  readonly maxAttempts: number;
  readonly source: JobSource;
  /** The kind's runsForSuspended (kept on the row, so parking needs no registry). */
  readonly runsForSuspended?: boolean;
}

/** One job of a kind for every tenant a fan-out reaches (or the platform), in one step. */
export interface FanOutRequest {
  readonly kind: JobKind;
  readonly scope: JobScope;
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
  readonly source: JobSource;
  readonly runsForSuspended: boolean;
  /** As ScheduleSlotRequest.tenantIds: absent, every tenant the kind runs for. */
  readonly tenantIds?: readonly string[];
}

export interface EnqueueResult {
  readonly id: string;
  /** False when a job with the key already existed (the request was a repeat). */
  readonly created: boolean;
}

/** A job a worker holds the lease of. */
export interface ClaimedJob {
  readonly id: string;
  readonly tenantId: string | null;
  readonly kind: JobKind;
  readonly payload: Readonly<Record<string, unknown>>;
  /** This attempt's number (1 on the first). */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly source: JobSource;
  /** Proves this worker still holds the job: a settle with a stale token changes nothing. */
  readonly leaseToken: string;
  readonly lockedUntil: Date;
}

/** A job as operators and tenant administrators see it. last_error is sanitized wording. */
export interface JobRecord {
  readonly id: string;
  readonly tenantId: string | null;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly source: JobSource;
  readonly runAt: string;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export type ScheduleOutcome = "succeeded" | "retrying" | "dead";

/** A recurring job's runtime state. */
export interface ScheduleState {
  readonly kind: JobKind;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastEnqueued: number;
  /**
   * The worst latest outcome across the tenants (or the platform) the kind ran for: dead if any
   * tenant's latest job of the kind is dead, else retrying if any is retrying, else succeeded.
   * One tenant's success never hides another's failure.
   */
  readonly lastStatus: ScheduleOutcome | null;
  /** The most recent failing tenant's error, when lastStatus is not succeeded. */
  readonly lastError: string | null;
  readonly lastFinishedAt: string | null;
  /** Tenants (or the platform) whose latest outcome is recorded, and how many of them failed. */
  readonly reported: number;
  readonly failing: number;
  /** Jobs of this kind now queued, running and dead (across tenants). */
  readonly queued: number;
  readonly running: number;
  readonly dead: number;
}

export interface ScheduleSlotRequest {
  readonly kind: JobKind;
  readonly scope: JobScope;
  readonly intervalMs: number;
  readonly maxAttempts: number;
  readonly now: Date;
  /**
   * The tenants a per-tenant slot reaches. Absent: every active tenant (a shared deployment) —
   * and every suspended one for a kind that runsForSuspended; a single-tenant deployment passes
   * its one tenant.
   */
  readonly tenantIds?: readonly string[];
  readonly runsForSuspended?: boolean;
}

export interface ScheduleSlotResult {
  /** The slot's time (the idempotency key of its jobs). */
  readonly slot: Date;
  readonly enqueued: number;
}

export interface JobListFilter {
  readonly status?: JobStatus;
  readonly kind?: JobKind;
  /** 1–200 (default 50). */
  readonly limit?: number;
}

export type ReplayOutcome = "replayed" | "not_found" | "not_dead";
export type DiscardOutcome = "discarded" | "not_found" | "not_dead";

/**
 * Where jobs live (a provider slot: JOB_STORE). The Postgres store is the durable one; the
 * in-memory store is for tests and local runs and is refused in production (ADR-048 D3).
 *
 * Two kinds of caller: the runner (claim, settle, schedule — every tenant's work) and people
 * (operators read and act across tenants; a tenant's administrators read their own tenant's
 * history). listTenantJobs reads the current tenant only, under its row-level security.
 */
export interface JobStore {
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  /** Lease up to `limit` due jobs of `kinds`; two callers never receive the same job. */
  claim(options: {
    readonly workerId: string;
    readonly kinds: readonly JobKind[];
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<ClaimedJob[]>;
  /** Mark succeeded. False when the lease was lost (expired and reclaimed, or dead-lettered). */
  complete(job: ClaimedJob): Promise<boolean>;
  /**
   * Hand a held job back unrun — queued, due now, its attempt not counted (the instance is
   * stopping, or the budget ran out before it started). False when the lease was lost.
   */
  release(job: ClaimedJob): Promise<boolean>;
  /**
   * Extend a held job's lease to `leaseMs` from now — while its handler is still running past
   * its time, so no other worker takes it. False when the lease was lost.
   */
  extendLease(job: ClaimedJob, leaseMs: number): Promise<boolean>;
  /** Queue another attempt at `runAt`. False when the lease was lost. */
  retry(job: ClaimedJob, error: string, runAt: Date): Promise<boolean>;
  /** Dead-letter after the last attempt. False when the lease was lost. */
  bury(job: ClaimedJob, error: string): Promise<boolean>;
  /**
   * If `kind`'s next slot is due at `now` — its recorded next time, or its last run plus the
   * interval given now, whichever is earlier, so a shortened interval applies at once — advance
   * it by the interval and enqueue the slot's jobs (one platform job, or one per tenant) in the
   * same step; null when not due. A slot is taken by one caller only.
   */
  takeScheduleSlot(request: ScheduleSlotRequest): Promise<ScheduleSlotResult | null>;
  /** Enqueue one job per tenant reached (or one platform job) in one step; how many were new. */
  fanOut(request: FanOutRequest): Promise<number>;
  /** Record how a recurring kind's latest job for `tenantId` (null: the platform) ended. */
  recordScheduleOutcome(
    kind: JobKind,
    tenantId: string | null,
    status: ScheduleOutcome,
    error: string | null
  ): Promise<void>;
  listSchedules(): Promise<ScheduleState[]>;
  /** Each schedule's last run and next slot only (cheap: the stale-schedule probe). */
  listScheduleTimes(): Promise<
    {
      readonly kind: JobKind;
      readonly lastRunAt: string | null;
      readonly nextRunAt: string | null;
    }[]
  >;
  /** Every tenant's jobs (operators). */
  listJobs(filter?: JobListFilter): Promise<JobRecord[]>;
  /** The current tenant's jobs only (its administrators). */
  listTenantJobs(filter?: JobListFilter): Promise<JobRecord[]>;
  getJob(id: string): Promise<JobRecord | null>;
  /** A dead job queued again from its first attempt. */
  replay(id: string): Promise<ReplayOutcome>;
  /** A dead job removed. */
  discard(id: string): Promise<DiscardOutcome>;
  /** Delete succeeded jobs finished before `before`; at most `limit`. */
  prune(before: Date, limit: number): Promise<number>;
  /** The tenants a fan-out reaches: every active one. */
  activeTenantIds(): Promise<string[]>;
}
