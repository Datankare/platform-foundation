/**
 * platform/agents/supabase-trajectory-store.ts — Durable trajectory persistence
 *
 * TrajectoryStore backed by Postgres via the Supabase REST API, using raw fetch()
 * — the SupabaseSocialStore / SupabaseModerationStore pattern, no JS client. That
 * choice is deliberate: a raw-fetch store is exercisable by its conformance kit
 * against a PostgREST fake, and the one store here built on the JS client is also
 * the one that shipped dead and untested (TASK-066).
 *
 * Table: agent_trajectories (migration 016, reshaped by 022) —
 *   id uuid / subject_kind / subject_id / trigger / scope_type / scope_id /
 *   status / steps jsonb / total_cost jsonb / version int / created_at / updated_at.
 *
 * Atomicity: addStep and updateStatus are compare-and-swap on `version`
 *   PATCH ?id=eq.X&version=eq.N  ->  zero rows returned means someone else won.
 * Do NOT split the CAS into read-then-write; that reopens the race it closes.
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

const TABLE = "agent_trajectories";
const MAX_CAS_RETRIES = 10;

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
  created_at: string;
  updated_at: string;
}

function headers(key: string, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export class SupabaseTrajectoryStore implements TrajectoryStore {
  private readonly url: string;
  private readonly key: string;

  constructor(url: string, serviceKey: string) {
    this.url = url.replace(/\/+$/, "");
    this.key = serviceKey;
  }

  private endpoint(query = ""): string {
    return `${this.url}/rest/v1/${TABLE}${query}`;
  }

  private async readRows(query: string): Promise<TrajectoryRow[]> {
    const res = await fetch(this.endpoint(query), {
      method: "GET",
      headers: headers(this.key),
    });
    if (!res.ok) {
      throw new Error(
        `agents: trajectory read failed (${res.status}): ${await res.text()}`
      );
    }
    return (await res.json()) as TrajectoryRow[];
  }

  async create(
    subject: TrajectorySubject,
    trigger: string,
    scopeType: "group" | "user" | "platform",
    scopeId?: string
  ): Promise<TrajectoryRecord> {
    const now = new Date().toISOString();
    const body = {
      // Supplied rather than defaulted so the caller has the id without a re-read.
      // generateId() is 16 hex chars and generateSecureId() 32; a uuid column takes
      // neither, which is why generateUuid exists.
      id: generateUuid(),
      subject_kind: subject.kind,
      subject_id: subject.id,
      trigger,
      scope_type: scopeType,
      scope_id: scopeId ?? null,
      status: "running",
      steps: [],
      total_cost: { tokens: 0, apiCalls: 0, usd: 0 },
      version: 1,
      created_at: now,
      updated_at: now,
    };
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: headers(this.key, "return=representation"),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `agents: trajectory create failed (${res.status}): ${await res.text()}`
      );
    }
    const rows = (await res.json()) as TrajectoryRow[];
    if (!rows.length) {
      throw new Error("agents: trajectory create returned no row");
    }
    return mapRow(rows[0]);
  }

  /**
   * Compare-and-swap one trajectory row. Reads current, applies `mutate`, then writes
   * conditional on the version it read. Zero rows back means another writer won; retry
   * against the new state. Bounded — exhaustion throws rather than silently dropping
   * the step.
   */
  private async casUpdate(
    trajectoryId: string,
    mutate: (row: TrajectoryRow) => Record<string, unknown>
  ): Promise<TrajectoryRecord | undefined> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const rows = await this.readRows(`?id=eq.${encodeURIComponent(trajectoryId)}`);
      if (!rows.length) return undefined;
      const current = rows[0];

      const patch = {
        ...mutate(current),
        version: current.version + 1,
        updated_at: new Date().toISOString(),
      };

      const res = await fetch(
        this.endpoint(
          `?id=eq.${encodeURIComponent(trajectoryId)}&version=eq.${current.version}`
        ),
        {
          method: "PATCH",
          headers: headers(this.key, "return=representation"),
          body: JSON.stringify(patch),
        }
      );
      if (!res.ok) {
        throw new Error(
          `agents: trajectory update failed (${res.status}): ${await res.text()}`
        );
      }
      const updated = (await res.json()) as TrajectoryRow[];
      if (updated.length) return mapRow(updated[0]);
      // 0 rows -> the version moved under us. Loop and re-read.
    }
    throw new Error(
      `agents: trajectory CAS exhausted ${MAX_CAS_RETRIES} retries for ${trajectoryId}`
    );
  }

  async addStep(trajectoryId: string, step: Step): Promise<TrajectoryRecord | undefined> {
    return this.casUpdate(trajectoryId, (row) => {
      const steps = [...asSteps(row.steps), step];
      const cost = asCost(row.total_cost);
      return {
        steps,
        total_cost: {
          tokens: cost.tokens,
          apiCalls: cost.apiCalls + (step.cost > 0 ? 1 : 0),
          usd: cost.usd + step.cost,
        },
      };
    });
  }

  async updateStatus(
    trajectoryId: string,
    status: TrajectoryStatus
  ): Promise<TrajectoryRecord | undefined> {
    return this.casUpdate(trajectoryId, () => ({ status }));
  }

  async getById(trajectoryId: string): Promise<TrajectoryRecord | undefined> {
    const rows = await this.readRows(`?id=eq.${encodeURIComponent(trajectoryId)}`);
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async query(options: TrajectoryQuery): Promise<readonly TrajectoryRecord[]> {
    const params: string[] = [];
    // agentId filters on subject_id: the in-memory store matches trajectory.agentId,
    // which mirrors subject.id.
    if (options.agentId)
      params.push(`subject_id=eq.${encodeURIComponent(options.agentId)}`);
    if (options.subjectKind)
      params.push(`subject_kind=eq.${encodeURIComponent(options.subjectKind)}`);
    if (options.subjectId)
      params.push(`subject_id=eq.${encodeURIComponent(options.subjectId)}`);
    if (options.scopeType)
      params.push(`scope_type=eq.${encodeURIComponent(options.scopeType)}`);
    if (options.scopeId)
      params.push(`scope_id=eq.${encodeURIComponent(options.scopeId)}`);
    if (options.status) params.push(`status=eq.${encodeURIComponent(options.status)}`);
    params.push("order=created_at.desc");
    if (options.limit && options.limit > 0) params.push(`limit=${options.limit}`);

    const rows = await this.readRows(`?${params.join("&")}`);
    return rows.map(mapRow);
  }
}
