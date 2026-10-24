/**
 * platform/agents/postgres-proposal-store.ts — Durable proposals (ADR-031 D2, ADR-053 D4)
 *
 * ProposalStore on Postgres through platform/data, in the request's tenant: row-level security
 * keeps each tenant's proposals apart; tenant_id is filled by its column default.
 *
 * Table: proposals (migration 027; actor_identity 046; tenant-scoped by 049). At most one
 * open, approved or used proposal per operation in a tenant (idx_proposals_tenant_one_live),
 * so a second create for a live operation is refused by the database.
 *
 * `decide` is conditional on status='proposed' in the WHERE clause, so a second decision
 * matches no row and returns undefined — atomic in the database rather than in a
 * read-then-write here (ADR-031 D4, and the lesson of TASK-063). `consume` is the same claim
 * on status='approved'.
 *
 * @module platform/agents
 */

import type {
  AgentIdentity,
  CreateProposalArgs,
  EffectType,
  ProposalQuery,
  ProposalRecord,
  ProposalStatus,
  ProposalStore,
  RiskLevel,
} from "@/platform/kernel";
import { generateUuid } from "./utils";
import { withTenantTx } from "@/platform/data";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProposalRow {
  id: string;
  operation_id: string;
  session_id: string;
  trajectory_id: string;
  label: string;
  status: string;
  actor_id: string;
  actor_role: string;
  /** The full proposing identity (migration 046); null on older rows. */
  actor_identity: unknown;
  effects: unknown;
  effective_risk: string;
  payload: unknown;
  observed_version: number | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
  updated_at: Date;
}

const ACTOR_TYPES: ReadonlySet<string> = new Set(["user", "agent", "system"]);

/**
 * The proposing identity. From actor_identity (migration 046) when it is a well-formed identity
 * whose id and role agree with the indexed columns; otherwise the legacy shape — an agent acting
 * for nobody — which every ownership check refuses (fail closed).
 */
function actorOf(row: ProposalRow): AgentIdentity {
  const legacy: AgentIdentity = {
    actorType: "agent",
    actorId: row.actor_id,
    agentRole: row.actor_role,
  };
  const raw = row.actor_identity;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return legacy;
  const a = raw as Record<string, unknown>;
  if (
    typeof a.actorType !== "string" ||
    !ACTOR_TYPES.has(a.actorType) ||
    a.actorId !== row.actor_id ||
    a.agentRole !== row.actor_role
  ) {
    return legacy;
  }
  return {
    actorType: a.actorType as AgentIdentity["actorType"],
    actorId: row.actor_id,
    agentRole: row.actor_role,
    ...(typeof a.onBehalfOf === "string" ? { onBehalfOf: a.onBehalfOf } : {}),
    ...(typeof a.sessionId === "string" ? { sessionId: a.sessionId } : {}),
    ...(isDelegation(a.delegation) ? { delegation: a.delegation } : {}),
  };
}

function isDelegation(v: unknown): v is NonNullable<AgentIdentity["delegation"]> {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.onBehalfOf === "string" &&
    typeof d.method === "string" &&
    Array.isArray(d.scope) &&
    d.scope.every((x) => typeof x === "string")
  );
}

function mapRow(row: ProposalRow): ProposalRecord {
  const actor = actorOf(row);
  return {
    proposalId: row.id,
    operationId: row.operation_id,
    sessionId: row.session_id,
    trajectoryId: row.trajectory_id,
    label: row.label,
    status: row.status as ProposalStatus,
    actor,
    effects: (Array.isArray(row.effects) ? row.effects : []) as readonly EffectType[],
    effectiveRisk: row.effective_risk as RiskLevel,
    payload: (typeof row.payload === "object" && row.payload !== null
      ? row.payload
      : {}) as Record<string, unknown>,
    observedVersion: row.observed_version ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : undefined,
    decisionNote: row.decision_note ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresProposalStore implements ProposalStore {
  async create(args: CreateProposalArgs): Promise<ProposalRecord> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(
        `insert into proposals
           (id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
            actor_identity, effects, effective_risk, payload, observed_version)
         values ($1::uuid, $2, $3, $4, $5, 'proposed', $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::int)
         returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
                   actor_identity, effects, effective_risk, payload, observed_version, decided_by,
                   decided_at, decision_note, created_at, updated_at`,
        [
          generateUuid(),
          args.operationId,
          args.sessionId,
          args.trajectoryId,
          args.label,
          args.actor.actorId,
          args.actor.agentRole,
          JSON.stringify(args.actor),
          JSON.stringify(args.effects),
          args.effectiveRisk,
          JSON.stringify(args.payload ?? {}),
          args.observedVersion ?? null,
        ]
      )
    );
    if (!rows.length) throw new Error("agents: proposal create returned no row");
    return mapRow(rows[0]);
  }

  async getById(proposalId: string): Promise<ProposalRecord | undefined> {
    if (!UUID_RE.test(proposalId)) return undefined;
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(
        `select id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
                actor_identity, effects, effective_risk, payload, observed_version, decided_by,
                decided_at, decision_note, created_at, updated_at
           from proposals where id = $1::uuid`,
        [proposalId]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async decide(
    proposalId: string,
    status: Exclude<ProposalStatus, "proposed" | "executed">,
    decidedBy: string,
    note?: string
  ): Promise<ProposalRecord | undefined> {
    if (!UUID_RE.test(proposalId)) return undefined;
    // status = 'proposed' is the guard: a second decision matches no row.
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(
        `update proposals
            set status = $2, decided_by = $3, decision_note = $4, decided_at = now(), updated_at = now()
          where id = $1::uuid and status = 'proposed'
          returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
                    actor_identity, effects, effective_risk, payload, observed_version, decided_by,
                    decided_at, decision_note, created_at, updated_at`,
        [proposalId, status, decidedBy, note ?? null]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async consume(proposalId: string): Promise<ProposalRecord | undefined> {
    if (!UUID_RE.test(proposalId)) return undefined;
    // status = 'approved' is the claim: a second consume, or a concurrent one, matches no row.
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(
        `update proposals
            set status = 'executed', updated_at = now()
          where id = $1::uuid and status = 'approved'
          returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
                    actor_identity, effects, effective_risk, payload, observed_version, decided_by,
                    decided_at, decision_note, created_at, updated_at`,
        [proposalId]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async query(options: ProposalQuery): Promise<readonly ProposalRecord[]> {
    // An absent filter is null and matches everything; a null limit is no limit.
    const limit = options.limit && options.limit > 0 ? options.limit : null;
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(
        `select id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
                actor_identity, effects, effective_risk, payload, observed_version, decided_by,
                decided_at, decision_note, created_at, updated_at
           from proposals
          where ($1::text is null or operation_id = $1)
            and ($2::text is null or trajectory_id = $2)
            and ($3::text is null or status = $3)
          order by created_at desc
          limit $4::int`,
        [
          options.operationId || null,
          options.trajectoryId || null,
          options.status || null,
          limit,
        ]
      )
    );
    return rows.map(mapRow);
  }
}
