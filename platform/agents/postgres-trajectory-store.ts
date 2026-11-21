/**
 * platform/agents/postgres-trajectory-store.ts — Durable trajectory persistence
 * (ADR-029 D4, ADR-053 D4, ADR-059)
 *
 * TrajectoryStore on Postgres through platform/data, in the request's tenant: row-level
 * security keeps each tenant's trajectories apart, and tenant_id is filled by its column
 * default, never written here.
 *
 * Tables: agent_trajectories (migration 016, reshaped by 022, tenant-scoped by 049, chained by
 * 052) — id uuid / subject_kind / subject_id / trigger / scope_type / scope_id / status /
 * total_cost jsonb / version int / created_at / updated_at / segment / previous_trajectory_id /
 * step_offset / step_count / steps_bytes / continued — and, since migration 076 (TASK-230,
 * ADR-059), its steps as rows: agent_trajectory_steps (tenant_id, trajectory_id, seq, step jsonb).
 *
 * The database keeps every rule of the steps (076's step trigger): a step is appended only at
 * seq = step_count, under the trajectory's row lock, within TRAJECTORY_MAX_STEPS steps and
 * TRAJECTORY_MAX_BYTES of text as printed, never into a segment that has a continuation; the
 * counters (step_count, steps_bytes) and `version` move with it; a step never moves and is
 * deleted only with its trajectory. This store asks the same before it writes, so a refusal by
 * the database is a race it lost or a bug, never the normal path.
 *
 * Reads: a segment's steps are read with the segment, in ONE statement (json_agg of its rows in
 * seq order) — a reader never sees a header and steps from different moments; a list (query)
 * reads no steps at all (TASK-230: review 12 M2's opt-in became the rule).
 *
 * Atomicity: addStep locks the chain's TAIL row `for update` (review 12 M1: resolved from any
 * segment's id through chain_root_id; once locked, a segment marked `continued` meanwhile is left
 * for its continuation) and appends in the same transaction, so concurrent appends serialise on
 * the tail and none is lost or misplaced; updateStatus locks its own row.
 *
 * The chain's shape is the database's to keep (migration 052, review 12 L6; 076): a trigger sets
 * each segment's chain_root_id and refuses a segment that is not its predecessor's + 1, in another
 * tenant, in another chain, with a step_offset other than the steps before it, or a change of any
 * of them afterwards — so no chain can be cyclic or forked, and no reader can be made to loop.
 *
 * P7:  Provider-aware — swap via TRAJECTORY_STORE env var
 * P18: Durable trajectories — survives the process, which is the whole point
 *
 * @module platform/agents
 */

import type { Trajectory, TrajectoryStatus, Step } from "./types";
import {
  assertStorableJson,
  TRAJECTORY_MAX_BYTES,
  TRAJECTORY_MAX_STEPS,
  TRAJECTORY_RETENTION_STEPS,
  trajectoryChainFull,
  trajectoryFull,
  trajectoryHasRoom,
} from "@/platform/errors/json-limits";
import { resolveTrajectoryMaxSegments } from "./budget-config";
import type {
  AddStepOptions,
  AppendedStep,
  RetentionBatch,
  TrajectoryStore,
  TrajectoryRecord,
  TrajectoryQuery,
  TrajectorySubject,
  UpdateStatusOptions,
  TrajectoryCost,
} from "./trajectory-store";
import { generateUuid } from "./utils";
import { withTenantTx, type Tx } from "@/platform/data";
import type { AbandonedTrajectories, WorkflowAbandonment } from "@/platform/kernel/types";
import { REAPED_ACTION } from "./trajectory-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many continuations a tail lock follows before giving up on a corrupt chain. */
const TAIL_LOCK_PASSES = 1_001;

interface TrajectoryRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  trigger: string;
  scope_type: string;
  scope_id: string | null;
  status: string;
  /** The segment's steps in order (json_agg of its rows; null when it has none or none was read). */
  steps?: unknown;
  total_cost: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
  /** The chain (migration 052, review 11 H-2). */
  segment: number;
  previous_trajectory_id: string | null;
  step_offset: number;
  /** The steps' counters (migration 076). */
  step_count: number;
}

/** The tail, locked, as addStep needs it (no step read). */
interface TailRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  trigger: string;
  scope_type: string;
  scope_id: string | null;
  total_cost: unknown;
  segment: number;
  step_offset: number;
  step_count: number;
  steps_bytes: string | number;
  continued: boolean;
}

function asCost(value: unknown): TrajectoryCost {
  const o = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    tokens: typeof o.tokens === "number" ? o.tokens : 0,
    apiCalls: typeof o.apiCalls === "number" ? o.apiCalls : 0,
    usd: typeof o.usd === "number" ? o.usd : 0,
  };
}

function asSteps(value: unknown): readonly Step[] {
  return Array.isArray(value) ? (value as Step[]) : [];
}

function mapRow(row: TrajectoryRow, list = false): TrajectoryRecord {
  const cost = asCost(row.total_cost);
  const trajectory: Trajectory = {
    trajectoryId: row.id,
    // agentId mirrors subject.id, as the in-memory store does. subject_kind is what
    // distinguishes an agent run from a session (ADR-029 D4).
    agentId: row.subject_id,
    steps: list ? [] : asSteps(row.steps),
    status: row.status as TrajectoryStatus,
    totalCost: cost.usd,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.segment > 1 ? { segment: row.segment } : {}),
    ...(row.previous_trajectory_id
      ? { previousTrajectoryId: row.previous_trajectory_id }
      : {}),
    ...(row.step_offset > 0 ? { stepOffset: row.step_offset } : {}),
    ...(list ? { stepCount: Number(row.step_count) } : {}),
  };
  return {
    trajectory,
    subject: {
      kind: row.subject_kind === "session" ? "session" : "agent",
      id: row.subject_id,
    },
    trigger: row.trigger,
    scopeType: row.scope_type as "group" | "user" | "platform",
    scopeId: row.scope_id,
    costSummary: cost,
  };
}

/**
 * query(): every column but the steps (a list reads none — TASK-230), with step_count. The SQL
 * is fixed text; only values are parameters.
 */
const QUERY = `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset, step_count from agent_trajectories
          where ($1::text is null or subject_id = $1)
            and ($2::text is null or subject_kind = $2)
            and ($3::text is null or subject_id = $3)
            and ($4::trajectory_scope is null or scope_type = $4::trajectory_scope)
            and ($5::text is null or scope_id = $5)
            and ($6::trajectory_status is null or status = $6::trajectory_status)
          order by created_at desc, segment desc
          limit $7::int`;

/**
 * One segment with its steps, in ONE statement (TASK-230): the steps' rows aggregated in seq order
 * by a subquery on the segment found — a reader never sees a header and steps from different
 * moments, and at most one segment's steps (≤ 1 000, ≤ 16 MiB of text by appends) are read. The
 * segment is chosen first (the inner select), so no other segment's steps are aggregated.
 */
const SEGMENT_BY_ID = `select t.id, t.subject_kind, t.subject_id, t.trigger, t.scope_type, t.scope_id, t.status, t.total_cost, t.version, t.created_at, t.updated_at, t.segment, t.previous_trajectory_id, t.step_offset, t.step_count,
       (select json_agg(s.step order by s.seq) from agent_trajectory_steps s where s.tenant_id = t.tenant_id and s.trajectory_id = t.id) as steps
  from agent_trajectories t where t.id = $1::uuid`;
const SEGMENT_TAIL = `select t.id, t.subject_kind, t.subject_id, t.trigger, t.scope_type, t.scope_id, t.status, t.total_cost, t.version, t.created_at, t.updated_at, t.segment, t.previous_trajectory_id, t.step_offset, t.step_count,
       (select json_agg(s.step order by s.seq) from agent_trajectory_steps s where s.tenant_id = t.tenant_id and s.trajectory_id = t.id) as steps
  from (select x.id, x.tenant_id, x.subject_kind, x.subject_id, x.trigger, x.scope_type, x.scope_id, x.status, x.total_cost, x.version, x.created_at, x.updated_at, x.segment, x.previous_trajectory_id, x.step_offset, x.step_count
          from agent_trajectories x
         where x.chain_root_id = (select r.chain_root_id from agent_trajectories r where r.id = $1::uuid)
         order by x.segment desc limit 1) t`;
const SEGMENT_NUMBER = `select t.id, t.subject_kind, t.subject_id, t.trigger, t.scope_type, t.scope_id, t.status, t.total_cost, t.version, t.created_at, t.updated_at, t.segment, t.previous_trajectory_id, t.step_offset, t.step_count,
       (select json_agg(s.step order by s.seq) from agent_trajectory_steps s where s.tenant_id = t.tenant_id and s.trajectory_id = t.id) as steps
  from agent_trajectories t
 where t.chain_root_id = (select r.chain_root_id from agent_trajectories r where r.id = $1::uuid)
   and t.segment = $2::int`;

export class PostgresTrajectoryStore implements TrajectoryStore {
  /** updateStatus honours `from` under the row's lock. */
  readonly supportsStatusCas = true;

  async create(
    subject: TrajectorySubject,
    trigger: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string
  ): Promise<TrajectoryRecord> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(
        `insert into agent_trajectories
           (id, subject_kind, subject_id, trigger, scope_type, scope_id, status, total_cost, version)
         values ($1::uuid, $2, $3, $4, $5::trajectory_scope, $6, 'running',
                 '{"tokens": 0, "apiCalls": 0, "usd": 0}'::jsonb, 1)
         returning id, subject_kind, subject_id, trigger, scope_type, scope_id, status, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset, step_count`,
        [
          // Supplied rather than defaulted so the caller has the id without a re-read.
          generateUuid(),
          subject.kind,
          subject.id,
          trigger,
          scopeType,
          scopeId ?? null,
        ]
      )
    );
    if (!rows.length) throw new Error("agents: trajectory create returned no row");
    return mapRow(rows[0]);
  }

  /**
   * Refuse, before the action runs, a chain whose tail has no room for one more step of the
   * largest storable size (review 10 L10): at most TRAJECTORY_MAX_STEPS steps and
   * TRAJECTORY_MAX_BYTES — read from the tail's counters (076), never from its steps — or, with
   * `rollover`, a full tail whose chain is at its segment cap (review 12 M2).
   */
  async assertRoomForStep(
    trajectoryId: string,
    options: AddStepOptions = {}
  ): Promise<void> {
    if (!UUID_RE.test(trajectoryId)) return;
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ n: number; bytes: string | number; segment: number }>(
        `select step_count as n, steps_bytes as bytes, segment
           from agent_trajectories
          where chain_root_id = (select chain_root_id from agent_trajectories where id = $1::uuid)
          order by segment desc limit 1`,
        [trajectoryId]
      )
    );
    if (!rows.length || trajectoryHasRoom(Number(rows[0].n), Number(rows[0].bytes)))
      return;
    if (!options.rollover) throw trajectoryFull("agent_trajectory_steps");
    const max = await resolveTrajectoryMaxSegments();
    if (Number(rows[0].segment) >= max)
      throw trajectoryChainFull("agent_trajectories", max);
  }

  /**
   * The chain's tail row, locked `for update` (review 12 M1), in `tx`: resolved from any segment's
   * id through chain_root_id; once locked, a segment marked `continued` by a continuation that
   * committed meanwhile (076: the continuation's own statement marks it) is passed for that
   * continuation, locked in turn. Its counters and `continued` are read from the locked row — the
   * same row the step trigger locks. No step is read. Undefined when the trajectory does not exist.
   */
  private async lockTail(tx: Tx, trajectoryId: string): Promise<TailRow | undefined> {
    const { rows: roots } = await tx.query<{ root: string }>(
      "select chain_root_id as root from agent_trajectories where id = $1::uuid",
      [trajectoryId]
    );
    if (!roots.length) return undefined;
    // Bounded (review 12 L6): each pass follows a continuation committed meanwhile, and a chain
    // has at most agents.trajectory_max_segments of them.
    for (let pass = 0; pass < TAIL_LOCK_PASSES; pass++) {
      const { rows } = await tx.query<TailRow>(
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, total_cost, segment, step_offset, step_count, steps_bytes, continued
           from agent_trajectories
          where chain_root_id = $1::uuid
          order by segment desc limit 1
          for update`,
        [roots[0].root]
      );
      if (!rows.length) return undefined;
      if (!rows[0].continued) return rows[0];
    }
    throw new Error(
      "agents: the trajectory chain's tail could not be found (a corrupt link)"
    );
  }

  async addStep(
    trajectoryId: string,
    step: Step,
    options: AddStepOptions = {}
  ): Promise<AppendedStep | undefined> {
    // Each step's caller-shaped input and output is bounded before it is stored (review 9 H2).
    assertStorableJson(step, "agent_trajectory_steps.step");
    if (!UUID_RE.test(trajectoryId)) return undefined;
    // Read before the transaction (cached): the cap on segments a rollover may reach.
    const maxSegments = options.rollover ? await resolveTrajectoryMaxSegments() : 0;
    const text = JSON.stringify(step);
    return withTenantTx(async (tx) => {
      // One transaction: the chain's tail is locked, and a full one is continued — in a new
      // segment — with the append (review 11 H-2). Always the tail (review 12 M1): a step is
      // never placed in an earlier segment it happens to fit in.
      const row = await this.lockTail(tx, trajectoryId);
      if (!row) return undefined;
      // The step's size as the database measures it (its text as printed, 076's steps_bytes):
      // one value, no other step read (TASK-230 — the document form read and rewrote them all).
      const { rows: sized } = await tx.query<{ b: string | number }>(
        "select octet_length($1::jsonb::text) as b",
        [text]
      );
      const bytes = Number(sized[0]?.b ?? 0);
      const cost = asCost(row.total_cost);
      let target = row.id;
      let seq = Number(row.step_count);
      let totalCost: TrajectoryCost;
      // The segment as a whole (review 10 L10): the pipeline asked before the action ran; this
      // refuses what a concurrent append left no room for — or rolls it over.
      if (
        seq + 1 <= TRAJECTORY_MAX_STEPS &&
        Number(row.steps_bytes) + bytes <= TRAJECTORY_MAX_BYTES
      ) {
        totalCost = {
          tokens: cost.tokens,
          apiCalls: cost.apiCalls + (step.cost > 0 ? 1 : 0),
          usd: cost.usd + step.cost,
        };
      } else {
        if (!options.rollover) throw trajectoryFull("agent_trajectory_steps");
        if (row.segment >= maxSegments) {
          throw trajectoryChainFull("agent_trajectories", maxSegments);
        }
        // The continuation: the database sets its chain_root_id, checks its link and marks the
        // tail `continued` in this statement (052, 076).
        target = generateUuid();
        seq = 0;
        totalCost = { tokens: 0, apiCalls: step.cost > 0 ? 1 : 0, usd: step.cost };
        await tx.query(
          `insert into agent_trajectories
             (id, subject_kind, subject_id, trigger, scope_type, scope_id, status, total_cost,
              version, segment, previous_trajectory_id, step_offset)
           values ($1::uuid, $2, $3, $4, $5::trajectory_scope, $6, 'running', $7::jsonb, 1,
                   $8::int, $9::uuid, $10::int)`,
          [
            target,
            row.subject_kind,
            row.subject_id,
            row.trigger,
            row.scope_type,
            row.scope_id,
            JSON.stringify(totalCost),
            row.segment + 1,
            row.id,
            // Every step before it: the tail's predecessors' and its own.
            row.step_offset + Number(row.step_count),
          ]
        );
      }
      // The step: one row at the segment's next place (the step trigger checks the place, the
      // limits and `continued` again, under the same lock, and moves the counters and version).
      await tx.query(
        `insert into agent_trajectory_steps (trajectory_id, seq, step)
         values ($1::uuid, $2::int, $3::jsonb)`,
        [target, seq, text]
      );
      const { rows } = await tx.query<{
        segment: number;
        step_offset: number;
        version: number;
      }>(
        `update agent_trajectories
            set total_cost = $2::jsonb, updated_at = now()
          where id = $1::uuid
          returning segment, step_offset, version`,
        [target, JSON.stringify(totalCost)]
      );
      if (!rows.length)
        throw new Error("agents: the step's trajectory was not found after it");
      return {
        trajectoryId: target,
        segment: Number(rows[0].segment),
        stepIndex: Number(rows[0].step_offset) + seq,
        version: Number(rows[0].version),
      };
    });
  }

  async updateStatus(
    trajectoryId: string,
    status: TrajectoryStatus,
    options: UpdateStatusOptions = {}
  ): Promise<TrajectoryRecord | undefined> {
    if (!UUID_RE.test(trajectoryId)) return undefined;
    const updated = await withTenantTx(async (tx) => {
      const { rows: locked } = await tx.query<{ status: string }>(
        "select status from agent_trajectories where id = $1::uuid for update",
        [trajectoryId]
      );
      if (!locked.length) return undefined;
      // Compare-and-set (TASK-175): the row is locked, so the status read is the one replaced.
      if (options.from && !options.from.includes(locked[0].status as TrajectoryStatus))
        return undefined;
      // The segment as updated, with its steps, in the same statement (one segment, one read).
      const { rows } = await tx.query<TrajectoryRow>(
        `with u as (
           update agent_trajectories
              set status = $2::trajectory_status, version = version + 1, updated_at = now()
            where id = $1::uuid
            returning id, tenant_id, subject_kind, subject_id, trigger, scope_type, scope_id, status, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset, step_count)
         select u.id, u.subject_kind, u.subject_id, u.trigger, u.scope_type, u.scope_id, u.status, u.total_cost, u.version, u.created_at, u.updated_at, u.segment, u.previous_trajectory_id, u.step_offset, u.step_count,
                (select json_agg(s.step order by s.seq) from agent_trajectory_steps s where s.tenant_id = u.tenant_id and s.trajectory_id = u.id) as steps
           from u`,
        [trajectoryId, status]
      );
      return rows[0];
    });
    return updated ? mapRow(updated) : undefined;
  }

  async chainTail(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    if (!UUID_RE.test(trajectoryId)) return undefined;
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(SEGMENT_TAIL, [trajectoryId])
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async chainSegment(
    trajectoryId: string,
    segment: number
  ): Promise<TrajectoryRecord | undefined> {
    if (!UUID_RE.test(trajectoryId) || !Number.isInteger(segment) || segment < 1) {
      return undefined;
    }
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(SEGMENT_NUMBER, [trajectoryId, segment])
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async getById(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    if (!UUID_RE.test(trajectoryId)) return undefined;
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(SEGMENT_BY_ID, [trajectoryId])
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async query(options: TrajectoryQuery): Promise<readonly TrajectoryRecord[]> {
    // agentId filters on subject_id: the in-memory store matches trajectory.agentId,
    // which mirrors subject.id. An absent filter is null and matches everything; a limit
    // of null is no limit. No steps are read (TASK-230): each record has steps [] and stepCount.
    const limit = options.limit && options.limit > 0 ? options.limit : null;
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(QUERY, [
        options.agentId || null,
        options.subjectKind || null,
        options.subjectId || null,
        options.scopeType || null,
        options.scopeId || null,
        options.status || null,
        limit,
      ])
    );
    return rows.map((r) => mapRow(r, true));
  }

  /**
   * Retention's delete, bounded by trajectories AND by their steps (TASK-230): the due ones oldest
   * first — `limit` + 1 candidates with the running sum of their step_count — those within both
   * bounds deleted (the first always), `more` when a candidate was left (confirmation CB3-4). The
   * steps go with their trajectory by the foreign key's cascade.
   */
  async deleteFinishedBefore(
    cutoff: Date,
    limit: number,
    maxSteps: number = TRAJECTORY_RETENTION_STEPS
  ): Promise<RetentionBatch> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ deleted: number; more: boolean }>(
        `with cand as (
           select id, updated_at, step_count from agent_trajectories
            where status in ('completed', 'failed') and updated_at < $1::timestamptz
            order by updated_at, id
            limit $2::int + 1
         ),
         ranked as (
           select id, row_number() over w as rn, sum(step_count) over w as run
             from cand
           window w as (order by updated_at, id rows between unbounded preceding and current row)
         ),
         pick as (
           select id from ranked where rn <= $2::int and (rn = 1 or run <= $3::bigint)
         ),
         gone as (
           delete from agent_trajectories where id in (select id from pick) returning 1
         )
         select (select count(*) from gone)::int as deleted,
                (select count(*) from cand) > (select count(*) from pick) as more`,
        [cutoff.toISOString(), limit, maxSteps]
      )
    );
    return { deleted: Number(rows[0]?.deleted ?? 0), more: rows[0]?.more === true };
  }

  /**
   * The reaper (TASK-193, platform/agents/trajectory-closure.ts), in the tenant's transaction. A
   * chain's last segment that is open, untouched since `cutoff`, with no open hold on any segment
   * of its chain — and not an app session's (its session owns it, audit B-5: it is deleted with
   * the session, migration 073) — is ended `failed` (a workflow's — its trigger one of
   * `workflows.triggers` — only past `workflows.cutoff`); `updated_at` is left as it was. Each
   * earlier segment of a chain whose last segment is over takes its status. Locked rows are
   * skipped, never waited on. Then, in the same transaction (the ended rows are locked), each one
   * with room gets a step saying so, at its next place (seq = step_count): fewer than
   * TRAJECTORY_MAX_STEPS steps and its text within TRAJECTORY_MAX_BYTES with the step's as printed
   * — a full one is ended without it, as before 076 (confirmation CB3-3: one full run must not
   * make the step insert fail the whole batch, every tick).
   */
  async closeAbandoned(
    cutoff: Date,
    limit: number,
    _openHolds?: () => Promise<ReadonlySet<string>>,
    workflows?: WorkflowAbandonment
  ): Promise<AbandonedTrajectories> {
    return withTenantTx(async (tx) => {
      const { rows } = await tx.query<{
        kind: string;
        id: string | null;
        was: string | null;
        until: string | null;
        n: number;
      }>(
        `with abandoned as (
           -- A workflow's trajectory (its trigger a workflow goal) takes the workflow cutoff, $4
           -- (review round 1, M1): a person continues a workflow when they come back to it.
           select t.id, t.status::text as was,
                  case when t.trigger = any($3::text[]) then $4::timestamptz
                       else $1::timestamptz end as until
             from agent_trajectories t
            where t.status in ('running', 'paused', 'awaiting_retry', 'indeterminate')
              and t.subject_kind <> 'session'
              and t.updated_at < case when t.trigger = any($3::text[]) then $4::timestamptz
                                      else $1::timestamptz end
              and not exists (select 1 from agent_trajectories c where c.previous_trajectory_id = t.id)
              and not exists (
                select 1 from proposals p
                 where p.status in ('proposed', 'approved', 'executing', 'indeterminate')
                   and p.trajectory_id in (select s.id::text from agent_trajectories s
                                            where s.chain_root_id = t.chain_root_id))
            order by t.updated_at
            limit $2::int
              for update of t skip locked
         ),
         closed as (
           update agent_trajectories t
              set status = 'failed', version = t.version + 1
             from abandoned a
            where t.id = a.id
           returning t.id, a.was, a.until
         ),
         segments as (
           update agent_trajectories t
              set status = tail.status, version = t.version + 1
             from agent_trajectories tail
            where tail.chain_root_id = t.chain_root_id and tail.id <> t.id
              and tail.status in ('completed', 'failed')
              and not exists (select 1 from agent_trajectories c where c.previous_trajectory_id = tail.id)
              and t.status in ('running', 'paused', 'awaiting_retry', 'indeterminate')
              and exists (select 1 from agent_trajectories c where c.previous_trajectory_id = t.id)
           returning t.id
         )
         select 'closed' as kind, id::text as id, was,
                to_char(until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as until, 1 as n
           from closed
         union all
         select 'segments', null, null, null, count(*)::int from segments`,
        [
          cutoff.toISOString(),
          limit,
          workflows?.triggers ?? [],
          (workflows?.cutoff ?? cutoff).toISOString(),
        ]
      );
      const closed = rows.filter((r) => r.kind === "closed" && r.id);
      if (closed.length) {
        // The closing step, where it fits (confirmation CB3-3); the step trigger checks the place
        // and the limits again under the row lock this transaction already holds.
        await tx.query(
          `insert into agent_trajectory_steps (trajectory_id, seq, step)
           select t.id, t.step_count, x.step
             from unnest($1::uuid[], $2::text[], $3::text[]) as c(id, was, until)
             join agent_trajectories t on t.id = c.id
            cross join lateral (
              select jsonb_build_object(
                       'stepIndex', t.step_offset + t.step_count,
                       'action', $4::text, 'boundary', 'cognition',
                       'input', jsonb_build_object('reaper', 'agents.trajectory-retention'),
                       'output', jsonb_build_object('status', 'failed', 'was', c.was,
                         'reason', jsonb_build_object('key', 'screens.records.trajectory_abandoned', 'params',
                           jsonb_build_object('since', c.until))),
                       'cost', 0, 'durationMs', 0,
                       'timestamp', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) as step
            ) x
            where t.step_count < $5::int
              and t.steps_bytes + octet_length(x.step::text) <= $6::bigint`,
          [
            closed.map((r) => r.id),
            closed.map((r) => r.was),
            closed.map((r) => r.until),
            REAPED_ACTION,
            TRAJECTORY_MAX_STEPS,
            TRAJECTORY_MAX_BYTES,
          ]
        );
      }
      return {
        closed: closed.length,
        indeterminate: closed.filter((r) => r.was === "indeterminate").length,
        segments: rows.find((r) => r.kind === "segments")?.n ?? 0,
      };
    });
  }
}
