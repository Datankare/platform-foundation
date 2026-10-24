/**
 * platform/jobs/memory-store.ts — the job store in one process's memory
 *
 * For tests and local runs: the same contract as the Postgres store (the job-store conformance
 * kit runs against both), held in a Map, so it is lost on restart and not shared between
 * instances — which is why production refuses it (ADR-048 D3). One process is one claimer, and
 * every step below completes before the next await, so two claims never receive the same job.
 *
 * Tenants: a job carries its tenant id; listTenantJobs shows the current tenant's only, as
 * row-level security does. Which tenants are active and which suspended (for the claim and the
 * fan-out) is asked of injectable resolvers — by default the tenant directory. A suspended
 * tenant's job is claimed only when its kind runsForSuspended. Postgres parks a non-active
 * tenant's jobs (status parked) so its claim never wades through them; here the claim filters
 * instead, which is the same answer.
 *
 * @module platform/jobs
 */

import { randomUUID } from "node:crypto";
import { peekTenant } from "@/platform/tenancy/context";
import { getTenantDirectory } from "@/platform/tenancy/directory";
import type {
  ClaimedJob,
  DiscardOutcome,
  EnqueueRequest,
  EnqueueResult,
  FanOutRequest,
  JobKind,
  JobListFilter,
  JobRecord,
  JobSource,
  JobStatus,
  JobStore,
  ReplayOutcome,
  ScheduleOutcome,
  ScheduleSlotRequest,
  ScheduleSlotResult,
  ScheduleState,
} from "./types";

interface Row {
  id: string;
  tenantId: string | null;
  kind: JobKind;
  payload: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  lockedUntil: number | null;
  lockedBy: string | null;
  leaseToken: string | null;
  lastError: string | null;
  source: JobSource;
  runsForSuspended: boolean;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

interface ScheduleRow {
  kind: JobKind;
  nextRunAt: number;
  lastRunAt: number | null;
  lastEnqueued: number;
}

interface OutcomeRow {
  status: ScheduleOutcome;
  error: string | null;
  at: number;
}

export interface MemoryJobStoreOptions {
  /** The clock (epoch ms); injectable so leases and due times are testable. */
  readonly now?: () => number;
  /** Every active tenant, for the fan-out. Default: the tenant directory's active tenants. */
  readonly activeTenants?: () => Promise<readonly string[]>;
  /** Every suspended tenant. Default: the tenant directory's suspended tenants. */
  readonly suspendedTenants?: () => Promise<readonly string[]>;
}

const byStatus = (status: string) => async (): Promise<readonly string[]> => {
  const tenants = await getTenantDirectory().listTenants();
  return tenants.filter((t) => t.status === status).map((t) => t.id);
};

/** Worst first: what a schedule's summary reports when its tenants' outcomes differ. */
const SEVERITY: Record<ScheduleOutcome, number> = { dead: 2, retrying: 1, succeeded: 0 };

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const clampLimit = (n: number | undefined) =>
  Math.min(Math.max(Math.floor(n ?? 50), 1), 200);

export class InMemoryJobStore implements JobStore {
  private readonly rows = new Map<string, Row>();
  private readonly schedules = new Map<JobKind, ScheduleRow>();
  /** kind → tenant ("" for the platform) → its latest outcome. */
  private readonly outcomes = new Map<JobKind, Map<string, OutcomeRow>>();
  private readonly now: () => number;
  private readonly tenants: () => Promise<readonly string[]>;
  private readonly suspended: () => Promise<readonly string[]>;

  constructor(options: MemoryJobStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tenants = options.activeTenants ?? byStatus("active");
    this.suspended =
      options.suspendedTenants ??
      (options.activeTenants ? async () => [] : byStatus("suspended"));
  }

  private find(tenantId: string | null, kind: JobKind, key: string): Row | undefined {
    for (const r of this.rows.values()) {
      if (r.tenantId === tenantId && r.kind === kind && r.idempotencyKey === key)
        return r;
    }
    return undefined;
  }

  private insert(request: EnqueueRequest): EnqueueResult {
    const existing = this.find(request.tenantId, request.kind, request.idempotencyKey);
    if (existing) return { id: existing.id, created: false };
    const now = this.now();
    const row: Row = {
      id: randomUUID(),
      tenantId: request.tenantId,
      kind: request.kind,
      payload: Object.freeze({ ...(request.payload ?? {}) }),
      idempotencyKey: request.idempotencyKey,
      status: "queued",
      attempts: 0,
      maxAttempts: request.maxAttempts,
      // Never before now: a past time would jump the queue.
      runAt: request.runAt ? Math.max(now, request.runAt.getTime()) : now,
      lockedUntil: null,
      lockedBy: null,
      leaseToken: null,
      lastError: null,
      source: request.source,
      runsForSuspended: request.runsForSuspended ?? false,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.rows.set(row.id, row);
    return { id: row.id, created: true };
  }

  async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    return this.insert(request);
  }

  async claim(options: {
    readonly workerId: string;
    readonly kinds: readonly JobKind[];
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<ClaimedJob[]> {
    const active = new Set(await this.tenants());
    const now = this.now();
    const kinds = new Set(options.kinds);
    // A lease that lapsed on the last attempt: dead (as job_claim does).
    for (const r of this.rows.values()) {
      if (
        r.status === "running" &&
        kinds.has(r.kind) &&
        (r.lockedUntil ?? 0) < now &&
        r.attempts >= r.maxAttempts
      ) {
        Object.assign(r, {
          status: "dead",
          lastError:
            "The worker running the last attempt stopped before it finished (its lease expired).",
          lockedUntil: null,
          lockedBy: null,
          leaseToken: null,
          finishedAt: now,
          updatedAt: now,
        });
      }
    }
    const suspended = new Set(await this.suspended());
    const runnable = (r: Row) =>
      kinds.has(r.kind) &&
      (r.tenantId === null ||
        active.has(r.tenantId) ||
        (r.runsForSuspended && suspended.has(r.tenantId)));
    // Lapsed leases first (they were due before), then queued jobs, tenants in turn: each
    // tenant's oldest, then each one's next, so one tenant's backlog cannot starve another.
    const lapsed = [...this.rows.values()]
      .filter((r) => r.status === "running" && (r.lockedUntil ?? 0) < now && runnable(r))
      .sort(
        (a, b) => (a.lockedUntil ?? 0) - (b.lockedUntil ?? 0) || a.id.localeCompare(b.id)
      );
    const queued = [...this.rows.values()]
      .filter((r) => r.status === "queued" && r.runAt <= now && runnable(r))
      .sort((a, b) => a.runAt - b.runAt || a.id.localeCompare(b.id));
    const turn = new Map<string, number>();
    const ranked = queued
      .map((r) => {
        const t = r.tenantId ?? "";
        const rank = turn.get(t) ?? 0;
        turn.set(t, rank + 1);
        return { r, rank };
      })
      .sort(
        (a, b) => a.rank - b.rank || a.r.runAt - b.r.runAt || a.r.id.localeCompare(b.r.id)
      )
      .map((x) => x.r);
    const due = [...lapsed, ...ranked].slice(0, options.limit);
    return due.map((r) => {
      Object.assign(r, {
        status: "running",
        attempts: r.attempts + 1,
        lockedUntil: now + options.leaseMs,
        lockedBy: options.workerId,
        leaseToken: randomUUID(),
        updatedAt: now,
      });
      return {
        id: r.id,
        tenantId: r.tenantId,
        kind: r.kind,
        payload: r.payload,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        source: r.source,
        leaseToken: r.leaseToken!,
        lockedUntil: new Date(r.lockedUntil!),
      };
    });
  }

  /** The row, if `job` still holds its lease. */
  private held(job: ClaimedJob): Row | undefined {
    const r = this.rows.get(job.id);
    return r && r.status === "running" && r.leaseToken === job.leaseToken ? r : undefined;
  }

  private settle(job: ClaimedJob, change: Partial<Row>): boolean {
    const r = this.held(job);
    if (!r) return false;
    Object.assign(r, {
      lockedUntil: null,
      lockedBy: null,
      leaseToken: null,
      updatedAt: this.now(),
      ...change,
    });
    return true;
  }

  async complete(job: ClaimedJob): Promise<boolean> {
    return this.settle(job, {
      status: "succeeded",
      lastError: null,
      finishedAt: this.now(),
    });
  }

  async release(job: ClaimedJob): Promise<boolean> {
    const r = this.held(job);
    if (!r) return false;
    return this.settle(job, {
      status: "queued",
      attempts: Math.max(0, r.attempts - 1),
      runAt: this.now(),
    });
  }

  async extendLease(job: ClaimedJob, leaseMs: number): Promise<boolean> {
    const r = this.held(job);
    if (!r) return false;
    r.lockedUntil = this.now() + leaseMs;
    r.updatedAt = this.now();
    return true;
  }

  async retry(job: ClaimedJob, error: string, runAt: Date): Promise<boolean> {
    return this.settle(job, {
      status: "queued",
      lastError: error,
      runAt: runAt.getTime(),
    });
  }

  async bury(job: ClaimedJob, error: string): Promise<boolean> {
    return this.settle(job, { status: "dead", lastError: error, finishedAt: this.now() });
  }

  /** The tenants a fan-out reaches: given, or every active one (and suspended, if the kind runs for them). */
  private async reach(
    scope: "platform" | "each-tenant",
    tenantIds: readonly string[] | undefined,
    runsForSuspended: boolean | undefined
  ): Promise<(string | null)[]> {
    if (scope === "platform") return [null];
    if (tenantIds) return [...tenantIds];
    return [
      ...(await this.tenants()),
      ...(runsForSuspended ? await this.suspended() : []),
    ];
  }

  async takeScheduleSlot(
    request: ScheduleSlotRequest
  ): Promise<ScheduleSlotResult | null> {
    const now = request.now.getTime();
    let s = this.schedules.get(request.kind);
    if (!s) {
      s = { kind: request.kind, nextRunAt: now, lastRunAt: null, lastEnqueued: 0 };
      this.schedules.set(request.kind, s);
    }
    const due = (row: ScheduleRow) =>
      Math.min(
        row.nextRunAt,
        row.lastRunAt === null ? row.nextRunAt : row.lastRunAt + request.intervalMs
      ) <= now;
    if (!due(s)) return null;
    const tenants = await this.reach(
      request.scope,
      request.tenantIds,
      request.runsForSuspended
    );
    // Taken: checked again and advanced before anything else can see it due.
    if (!due(s)) return null;
    s.nextRunAt = now + request.intervalMs;
    s.lastRunAt = now;
    const slot = new Date(now);
    let enqueued = 0;
    for (const tenantId of tenants) {
      const r = this.insert({
        tenantId,
        kind: request.kind,
        idempotencyKey: `schedule:${slot.toISOString()}`,
        maxAttempts: request.maxAttempts,
        source: "schedule",
        runAt: slot,
        runsForSuspended: request.runsForSuspended ?? false,
      });
      if (r.created) enqueued++;
    }
    s.lastEnqueued = enqueued;
    return { slot, enqueued };
  }

  async fanOut(request: FanOutRequest): Promise<number> {
    const tenants = await this.reach(
      request.scope,
      request.tenantIds,
      request.runsForSuspended
    );
    let created = 0;
    for (const tenantId of tenants) {
      const r = this.insert({
        tenantId,
        kind: request.kind,
        idempotencyKey: request.idempotencyKey,
        maxAttempts: request.maxAttempts,
        source: request.source,
        runsForSuspended: request.runsForSuspended,
      });
      if (r.created) created++;
    }
    return created;
  }

  async recordScheduleOutcome(
    kind: JobKind,
    tenantId: string | null,
    status: ScheduleOutcome,
    error: string | null
  ): Promise<void> {
    let byTenant = this.outcomes.get(kind);
    if (!byTenant) {
      byTenant = new Map();
      this.outcomes.set(kind, byTenant);
    }
    byTenant.set(tenantId ?? "", { status, error, at: this.now() });
  }

  async listSchedules(): Promise<ScheduleState[]> {
    return [...this.schedules.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((s) => {
        const of = (status: JobStatus) =>
          [...this.rows.values()].filter((r) => r.kind === s.kind && r.status === status)
            .length;
        const outcomes = [...(this.outcomes.get(s.kind)?.values() ?? [])];
        const worst = outcomes.reduce<OutcomeRow | null>(
          (w, o) =>
            !w ||
            SEVERITY[o.status] > SEVERITY[w.status] ||
            (SEVERITY[o.status] === SEVERITY[w.status] && o.at > w.at)
              ? o
              : w,
          null
        );
        const failing = outcomes.filter((o) => o.status !== "succeeded").length;
        return {
          kind: s.kind,
          nextRunAt: iso(s.nextRunAt),
          lastRunAt: iso(s.lastRunAt),
          lastEnqueued: s.lastEnqueued,
          lastStatus: worst?.status ?? null,
          lastError: worst && worst.status !== "succeeded" ? worst.error : null,
          lastFinishedAt: outcomes.length
            ? iso(Math.max(...outcomes.map((o) => o.at)))
            : null,
          reported: outcomes.length,
          failing,
          queued: of("queued"),
          running: of("running"),
          dead: of("dead"),
        };
      });
  }

  async listScheduleTimes(): Promise<
    { kind: JobKind; lastRunAt: string | null; nextRunAt: string | null }[]
  > {
    return [...this.schedules.values()].map((s) => ({
      kind: s.kind,
      lastRunAt: iso(s.lastRunAt),
      nextRunAt: iso(s.nextRunAt),
    }));
  }

  private records(rows: Iterable<Row>, filter: JobListFilter = {}): JobRecord[] {
    return [...rows]
      .filter(
        (r) =>
          (!filter.status || r.status === filter.status) &&
          (!filter.kind || r.kind === filter.kind)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
      .slice(0, clampLimit(filter.limit))
      .map(toRecord);
  }

  async listJobs(filter?: JobListFilter): Promise<JobRecord[]> {
    return this.records(this.rows.values(), filter);
  }

  async listTenantJobs(filter?: JobListFilter): Promise<JobRecord[]> {
    const tenant = peekTenant()?.tenantId;
    if (!tenant) return [];
    return this.records(
      [...this.rows.values()].filter((r) => r.tenantId === tenant),
      filter
    );
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const r = this.rows.get(id);
    return r ? toRecord(r) : null;
  }

  async replay(id: string): Promise<ReplayOutcome> {
    const r = this.rows.get(id);
    if (!r) return "not_found";
    if (r.status !== "dead") return "not_dead";
    const now = this.now();
    Object.assign(r, {
      status: "queued",
      attempts: 0,
      runAt: now,
      source: "replay",
      finishedAt: null,
      updatedAt: now,
    });
    return "replayed";
  }

  async discard(id: string): Promise<DiscardOutcome> {
    const r = this.rows.get(id);
    if (!r) return "not_found";
    if (r.status !== "dead") return "not_dead";
    this.rows.delete(id);
    return "discarded";
  }

  async prune(before: Date, limit: number): Promise<number> {
    const at = before.getTime();
    let n = 0;
    for (const [id, r] of this.rows) {
      if (n >= limit) break;
      if (r.status === "succeeded" && (r.finishedAt ?? Infinity) < at) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }

  async activeTenantIds(): Promise<string[]> {
    return [...(await this.tenants())];
  }

  /** Every job (tests). */
  size(): number {
    return this.rows.size;
  }
}

function toRecord(r: Row): JobRecord {
  return {
    id: r.id,
    tenantId: r.tenantId,
    kind: r.kind,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    source: r.source,
    runAt: new Date(r.runAt).toISOString(),
    lastError: r.lastError,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    finishedAt: iso(r.finishedAt),
  };
}
