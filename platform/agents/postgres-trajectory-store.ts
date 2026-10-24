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
 * Atomicity: addStep and updateStatus read the row `for update` and write it in the same
 * transaction, so concurrent appends serialise on the row lock and none is lost. `version`
 * still moves on every write, for readers that compare it.
 *
 * P7:  Provider-aware — swap via TRAJECTORY_STORE env var
 * P18: Durable trajectories — survives the process, which is the whole point
 *
 * @module platform/agents
 */

import type { Trajectory, TrajectoryStatus, Step } from "./types";
import type {
  TrajectoryStore,
  TrajectoryRecord,
  TrajectoryQuery,
  TrajectorySubject,
  TrajectoryCost,
} from "./trajectory-store";
import { generateUuid } from "./utils";
import { withTenantTx, type Tx } from "@/platform/data";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export class PostgresTrajectoryStore implements TrajectoryStore {
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
         returning id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at`,
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
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at from agent_trajectories where id = $1::uuid for update`,
        [trajectoryId]
      );
      if (!rows.length) return undefined;
      return mutate(tx, rows[0]);
    });
    return updated ? mapRow(updated) : undefined;
  }

  async addStep(trajectoryId: string, step: Step): Promise<TrajectoryRecord | undefined> {
    return this.lockedUpdate(trajectoryId, async (tx, row) => {
      const steps = [...asSteps(row.steps), step];
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
          returning id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at`,
        [row.id, JSON.stringify(steps), JSON.stringify(totalCost)]
      );
      return rows[0];
    });
  }

  async updateStatus(
    trajectoryId: string,
    status: TrajectoryStatus
  ): Promise<TrajectoryRecord | undefined> {
    return this.lockedUpdate(trajectoryId, async (tx, row) => {
      const { rows } = await tx.query<TrajectoryRow>(
        `update agent_trajectories
            set status = $2::trajectory_status, version = version + 1, updated_at = now()
          where id = $1::uuid
          returning id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at`,
        [row.id, status]
      );
      return rows[0];
    });
  }

  async getById(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    if (!UUID_RE.test(trajectoryId)) return undefined;
    const { rows } = await withTenantTx((tx) =>
      tx.query<TrajectoryRow>(
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at from agent_trajectories where id = $1::uuid`,
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
        `select id, subject_kind, subject_id, trigger, scope_type, scope_id, status, steps, total_cost, version, created_at, updated_at from agent_trajectories
          where ($1::text is null or subject_id = $1)
            and ($2::text is null or subject_kind = $2)
            and ($3::text is null or subject_id = $3)
            and ($4::trajectory_scope is null or scope_type = $4::trajectory_scope)
            and ($5::text is null or scope_id = $5)
            and ($6::trajectory_status is null or status = $6::trajectory_status)
          order by created_at desc
          limit $7::int`,
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
}
