/**
 * platform/agents/postgres-trajectory-store.ts — Durable trajectory persistence
 * (ADR-029 D4, ADR-053 D4)
 *
 * TrajectoryStore on Postgres through platform/data, in the request's tenant: row-level
 * security keeps each tenant's trajectories apart, and tenant_id is filled by its column
 * default, never written here.
 *
 * Table: agent_trajectories (migration 016, reshaped by 022, tenant-scoped by 049) —
 *   id uuid / subject_kind / subject_id / trigger / scope_type / scope_id /
 *   status / steps jsonb / total_cost jsonb / version int / created_at / updated_at.
 *
 * Atomicity: addStep locks the chain's TAIL row `for update` (review 12 M1: resolved from any
 * segment's id through chain_root_id, then re-checked for a continuation once locked) and writes
 * it in the same transaction, so concurrent appends serialise on the tail and none is lost or
 * misplaced; updateStatus locks its own row. `version` still moves on every write, for readers
 * that compare it.
 *
 * The chain's shape is the database's to keep (migration 052, review 12 L6): a trigger sets each
 * segment's chain_root_id and refuses a segment that is not its predecessor's + 1, in another
 * tenant, in another chain, with a step_offset other than the steps before it, or a change of
 * any of them afterwards — so no chain can be cyclic or forked, and no reader can be made to
 * loop.
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
  trajectoryChainFull,
  trajectoryFull,
  trajectoryHasRoom,
} from "@/platform/errors/json-limits";
import { resolveTrajectoryMaxSegments } from "./budget-config";
import type {
  AddStepOptions,
  TrajectoryStore,
  TrajectoryRecord,
  TrajectoryQuery,
  TrajectorySubject,
  UpdateStatusOptions,
  TrajectoryCost,
} from "./trajectory-store";
import { generateUuid } from "./utils";
import { withTenantTx, type Tx } from "@/platform/data";

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
  steps: unknown;
  total_cost: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
  /** The chain (migration 052, review 11 H-2). */
  segment: number;
  previous_trajectory_id: string | null;
  step_offset: number;
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

function mapRow(row: TrajectoryRow): TrajectoryRecord {
  const cost = asCost(row.total_cost);
  const trajectory: Trajectory = {
    trajectoryId: row.id,
    // agentId mirrors subject.id, as the in-memory store does. subject_kind is what
    // distinguishes an agent run from a session (ADR-029 D4).
    agentId: row.subject_id,
    steps: asSteps(row.steps),
    status: row.status as TrajectoryStatus,
    totalCost: cost.usd,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.segment > 1 ? { segment: row.segment } : {}),
    ...(row.previous_trajectory_id
      ? { previousTrajectoryId: row.previous_trajectory_id }
      : {}),
    ...(row.step_offset > 0 ? { stepOffset: row.step_offset } : {}),
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

/** query(): every column (the SQL is fixed text; only values are parameters). */
const QUERY_WITH_STEPS = `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset from agent_trajectories
          where ($1::text is null or subject_id = $1)
            and ($2::text is null or subject_kind = $2)
            and ($3::text is null or subject_id = $3)
            and ($4::trajectory_scope is null or scope_type = $4::trajectory_scope)
            and ($5::text is null or scope_id = $5)
            and ($6::trajectory_status is null or status = $6::trajectory_status)
          order by created_at desc, segment desc
          limit $7::int`;
/** query() with the steps left out (review 12 M2). */
const QUERY_WITHOUT_STEPS = `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, '[]'::jsonb as steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset from agent_trajectories
          where ($1::text is null or subject_id = $1)
            and ($2::text is null or subject_kind = $2)
            and ($3::text is null or subject_id = $3)
            and ($4::trajectory_scope is null or scope_type = $4::trajectory_scope)
            and ($5::text is null or scope_id = $5)
            and ($6::trajectory_status is null or status = $6::trajectory_status)
          order by created_at desc, segment desc
          limit $7::int`;

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
           (id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version)
         values ($1::uuid, $2, $3, $4, $5::trajectory_scope, $6, 'running', '[]'::jsonb,
                 '{"tokens": 0, "apiCalls": 0, "usd": 0}'::jsonb, 1)
         returning id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset`,
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
   * Lock one trajectory row, apply `mutate`, write it back — one transaction, so a
   * concurrent writer waits for the lock and then sees this write.
   */
  private async lockedUpdate(
    trajectoryId: string,
    mutate: (tx: Tx, row: TrajectoryRow) => Promise<TrajectoryRow | undefined>
  ): Promise<TrajectoryRecord | undefined> {
    if (!UUID_RE.test(trajectoryId)) return undefined;
    const updated = await withTenantTx(async (tx) => {
      const { rows } = await tx.query<TrajectoryRow>(
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset from agent_trajectories where id = $1::uuid for update`,
        [trajectoryId]
      );
      if (!rows.length) return undefined;
      return mutate(tx, rows[0]);
    });
    return updated ? mapRow(updated) : undefined;
  }

  /**
   * Refuse, before the action runs, a chain whose tail has no room for one more step of the
   * largest storable size (review 10 L10): at most TRAJECTORY_MAX_STEPS steps and
   * TRAJECTORY_MAX_BYTES — or, with `rollover`, a full tail whose chain is at its segment cap
   * (review 12 M2).
   */
  async assertRoomForStep(
    trajectoryId: string,
    options: AddStepOptions = {}
  ): Promise<void> {
    if (!UUID_RE.test(trajectoryId)) return;
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ n: number; bytes: number; segment: number }>(
        `select jsonb_array_length(steps) as n, octet_length(steps::text) as bytes, segment
           from agent_trajectories
          where chain_root_id = (select chain_root_id from agent_trajectories where id = $1::uuid)
          order by segment desc limit 1`,
        [trajectoryId]
      )
    );
    if (!rows.length || trajectoryHasRoom(Number(rows[0].n), Number(rows[0].bytes)))
      return;
    if (!options.rollover) throw trajectoryFull("agent_trajectories.steps");
    const max = await resolveTrajectoryMaxSegments();
    if (Number(rows[0].segment) >= max)
      throw trajectoryChainFull("agent_trajectories", max);
  }

  /**
   * The chain's tail row, locked `for update` (review 12 M1), in `tx`: resolved from any segment's
   * id through chain_root_id; once locked, re-checked for a continuation a concurrent append
   * committed meanwhile (then that one is locked instead). Undefined when the trajectory does not
   * exist.
   */
  private async lockTail(
    tx: Tx,
    trajectoryId: string
  ): Promise<TrajectoryRow | undefined> {
    const { rows: roots } = await tx.query<{ root: string }>(
      "select chain_root_id as root from agent_trajectories where id = $1::uuid",
      [trajectoryId]
    );
    if (!roots.length) return undefined;
    // Bounded (review 12 L6): each pass follows a continuation committed meanwhile, and a chain
    // has at most agents.trajectory_max_segments of them.
    for (let pass = 0; pass < TAIL_LOCK_PASSES; pass++) {
      const { rows } = await tx.query<TrajectoryRow>(
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset from agent_trajectories
          where chain_root_id = $1::uuid
          order by segment desc limit 1
          for update`,
        [roots[0].root]
      );
      if (!rows.length) return undefined;
      const { rows: later } = await tx.query(
        "select 1 from agent_trajectories where previous_trajectory_id = $1::uuid",
        [rows[0].id]
      );
      if (!later.length) return rows[0];
    }
    throw new Error(
      "agents: the trajectory chain's tail could not be found (a corrupt link)"
    );
  }

  async addStep(
    trajectoryId: string,
    step: Step,
    options: AddStepOptions = {}
  ): Promise<TrajectoryRecord | undefined> {
    // Each step's caller-shaped input and output is bounded before it is stored (review 9 H2).
    assertStorableJson(step, "agent_trajectories.steps[]");
    if (!UUID_RE.test(trajectoryId)) return undefined;
    // Read before the transaction (cached): the cap on segments a rollover may reach.
    const maxSegments = options.rollover ? await resolveTrajectoryMaxSegments() : 0;
    const updated = await withTenantTx(async (tx) => {
      // One transaction: the chain's tail is locked, and a full one is continued — in a new
      // segment — with the append (review 11 H-2). Always the tail (review 12 M1): a step is
      // never placed in an earlier segment it happens to fit in.
      const row = await this.lockTail(tx, trajectoryId);
      if (!row) return undefined;
      const steps = [...asSteps(row.steps), step];
      const text = JSON.stringify(steps);
      // The trajectory as a whole (review 10 L10): the pipeline asked before the action ran;
      // this refuses what a concurrent append left no room for — or rolls it over.
      if (
        steps.length <= TRAJECTORY_MAX_STEPS &&
        Buffer.byteLength(text, "utf8") <= TRAJECTORY_MAX_BYTES
      ) {
        const cost = asCost(row.total_cost);
        const totalCost: TrajectoryCost = {
          tokens: cost.tokens,
          apiCalls: cost.apiCalls + (step.cost > 0 ? 1 : 0),
          usd: cost.usd + step.cost,
        };
        const { rows } = await tx.query<TrajectoryRow>(
          `update agent_trajectories
              set steps = $2::jsonb, total_cost = $3::jsonb, version = version + 1, updated_at = now()
            where id = $1::uuid
            returning id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset`,
          [row.id, text, JSON.stringify(totalCost)]
        );
        return rows[0];
      }
      if (!options.rollover) throw trajectoryFull("agent_trajectories.steps");
      if (row.segment >= maxSegments) {
        throw trajectoryChainFull("agent_trajectories", maxSegments);
      }
      // The continuation: the database sets its chain_root_id and checks its link (052).
      const { rows } = await tx.query<TrajectoryRow>(
        `insert into agent_trajectories
           (id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost,
            version, segment, previous_trajectory_id, step_offset)
         values ($1::uuid, $2, $3, $4, $5::trajectory_scope, $6, 'running', $7::jsonb, $8::jsonb, 1,
                 $9::int, $10::uuid, $11::int)
         returning id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset`,
        [
          generateUuid(),
          row.subject_kind,
          row.subject_id,
          row.trigger,
          row.scope_type,
          row.scope_id,
          JSON.stringify([step]),
          JSON.stringify({
            tokens: 0,
            apiCalls: step.cost > 0 ? 1 : 0,
            usd: step.cost,
          }),
          row.segment + 1,
          row.id,
          // Every step before it: the tail's predecessors' and its own.
          row.step_offset + asSteps(row.steps).length,
        ]
      );
      return rows[0];
    });
    return updated ? mapRow(updated) : undefined;
  }

  async updateStatus(
    trajectoryId: string,
    status: TrajectoryStatus,
    options: UpdateStatusOptions = {}
  ): Promise<TrajectoryRecord | undefined> {
    return this.lockedUpdate(trajectoryId, async (tx, row) => {
      // Compare-and-set (TASK-175): the row is locked, so the status read is the one replaced.
      if (options.from && !options.from.includes(row.status as TrajectoryStatus))
        return undefined;
      const { rows } = await tx.query<TrajectoryRow>(
        `update agent_trajectories
            set status = $2::trajectory_status, version = version + 1, updated_at = now()
          where id = $1::uuid
          returning id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset`,
        [row.id, status]
      );
      return rows[0];
    });
  }

  async chainTail(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    if (!UUID_RE.test(trajectoryId)) return undefined;
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset from agent_trajectories
          where chain_root_id = (select chain_root_id from agent_trajectories where id = $1::uuid)
          order by segment desc limit 1`,
        [trajectoryId]
      )
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
      tx.query<TrajectoryRow>(
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset from agent_trajectories
          where chain_root_id = (select chain_root_id from agent_trajectories where id = $1::uuid)
            and segment = $2::int`,
        [trajectoryId, segment]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async getById(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    if (!UUID_RE.test(trajectoryId)) return undefined;
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at, segment, previous_trajectory_id, step_offset from agent_trajectories where id = $1::uuid`,
        [trajectoryId]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async query(options: TrajectoryQuery): Promise<readonly TrajectoryRecord[]> {
    // agentId filters on subject_id: the in-memory store matches trajectory.agentId,
    // which mirrors subject.id. An absent filter is null and matches everything; a limit
    // of null is no limit.
    const limit = options.limit && options.limit > 0 ? options.limit : null;
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(
        // The steps left out on request (review 12 M2): finding a trajectory without reading them.
        options.withoutSteps ? QUERY_WITHOUT_STEPS : QUERY_WITH_STEPS,
        [
          options.agentId || null,
          options.subjectKind || null,
          options.subjectId || null,
          options.scopeType || null,
          options.scopeId || null,
          options.status || null,
          limit,
        ]
      )
    );
    return rows.map(mapRow);
  }

  async deleteFinishedBefore(cutoff: Date, limit: number): Promise<number> {
    const { rowCount } = await withTenantTx((tx) =>
      tx.query(
        `delete from agent_trajectories
          where id in (select id from agent_trajectories
                        where status in ('completed', 'failed') and updated_at < $1::timestamptz
                        order by updated_at
                        limit $2::int)`,
        [cutoff.toISOString(), limit]
      )
    );
    return rowCount;
  }
}
