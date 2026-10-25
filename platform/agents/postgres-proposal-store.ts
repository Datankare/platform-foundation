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
 * read-then-write here (ADR-031 D4, and the lesson of TASK-063). `consume`, `claim`, `complete`
 * and `release` are the same compare-and-set on the status they move from (review 10 H2: a run
 * claims its approval approved -> executing, and ends it executed, or approved again when it
 * failed before taking effect) — and `complete` and `release` on the claim's run token too
 * (review 11 H-1: a run slower than its lease could end a claim it no longer held).
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
import { assertStorableJson } from "@/platform/errors/json-limits";

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
  /** Why the last run failed before taking effect (migration 052, review 10 H2). */
  last_run_error: string | null;
  /** The current claim's token (migration 052, review 11 H-1). */
  run_token: string | null;
  run_atomic: boolean | null;
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
    ...(row.last_run_error ? { lastRunError: row.last_run_error } : {}),
    ...(row.run_token ? { runToken: row.run_token } : {}),
    ...(row.run_token && row.run_atomic ? { runAtomic: true } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresProposalStore implements ProposalStore {
  async create(args: CreateProposalArgs): Promise<ProposalRecord> {
    // Caller-shaped JSON is bounded before it is stored (review 9 H2: coded refusal).
    assertStorableJson(args.payload ?? {}, "proposals.payload");
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(
        `insert into proposals
           (id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
            actor_identity, effects, effective_risk, payload, observed_version)
         values ($1::uuid, $2, $3, $4, $5, 'proposed', $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::int)
         returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
                   actor_identity, effects, effective_risk, payload, observed_version, decided_by,
                   decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
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
                decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at
           from proposals where id = $1::uuid`,
        [proposalId]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async decide(
    proposalId: string,
    status: Exclude<
      ProposalStatus,
      "proposed" | "executed" | "executing" | "indeterminate"
    >,
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
                    decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
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
                    decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
        [proposalId]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  /**
   * Run one compare-and-set update of `proposalId` (its WHERE names the status, and the run token,
   * it moves from), returning the row it moved, or undefined when none matched.
   */
  private async update(
    proposalId: string,
    sql: string,
    values: readonly unknown[]
  ): Promise<ProposalRecord | undefined> {
    if (!UUID_RE.test(proposalId)) return undefined;
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(sql, [proposalId, ...values])
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async claim(
    proposalId: string,
    options: { readonly atomic?: boolean } = {}
  ): Promise<ProposalRecord | undefined> {
    // A fresh token per claim (its generation, review 11 H-1): only this run may end it.
    return this.update(
      proposalId,
      `update proposals set status = 'executing', run_token = $2::uuid, run_atomic = $3, updated_at = now()
          where id = $1::uuid and status = 'approved'
          returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role, actor_identity, effects, effective_risk, payload, observed_version, decided_by, decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
      [generateUuid(), options.atomic === true]
    );
  }

  async complete(
    proposalId: string,
    runToken: string
  ): Promise<ProposalRecord | undefined> {
    if (!UUID_RE.test(runToken)) return undefined;
    // Executing or undecided by this claim's token; or already executed by it (the recovery found
    // its step) — then the update is a no-op that returns the row.
    return this.update(
      proposalId,
      `update proposals set status = 'executed', updated_at = now()
          where id = $1::uuid and run_token = $2::uuid and status in ('executing', 'indeterminate', 'executed')
          returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role, actor_identity, effects, effective_risk, payload, observed_version, decided_by, decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
      [runToken]
    );
  }

  async release(
    proposalId: string,
    note: string,
    runToken: string
  ): Promise<ProposalRecord | undefined> {
    if (!UUID_RE.test(runToken)) return undefined;
    return this.update(
      proposalId,
      `update proposals set status = 'approved', last_run_error = $3, run_token = null, run_atomic = null, updated_at = now()
          where id = $1::uuid and run_token = $2::uuid and status in ('executing', 'indeterminate')
          returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role, actor_identity, effects, effective_risk, payload, observed_version, decided_by, decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
      [runToken, note.slice(0, 1000)]
    );
  }

  async resolveIndeterminate(
    proposalId: string,
    resolution: "executed" | "approved",
    decidedBy: string,
    note: string
  ): Promise<ProposalRecord | undefined> {
    return resolution === "approved"
      ? this.update(
          proposalId,
          `update proposals set status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3, run_token = null, run_atomic = null, updated_at = now()
          where id = $1::uuid and status = 'indeterminate'
          returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role, actor_identity, effects, effective_risk, payload, observed_version, decided_by, decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
          [decidedBy, note.slice(0, 1000)]
        )
      : this.update(
          proposalId,
          `update proposals set status = 'executed', last_run_error = $2, updated_at = now()
          where id = $1::uuid and status = 'indeterminate'
          returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role, actor_identity, effects, effective_risk, payload, observed_version, decided_by, decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
          [`marked executed by ${decidedBy}: ${note}`.slice(0, 1000)]
        );
  }

  /**
   * One transaction of the current tenant around `fn`: every tenant-transaction write inside
   * (the claim, the effect, the step, the completion) joins it (platform/data), so they commit
   * together or roll back together.
   */
  atomically<T>(fn: () => Promise<T>): Promise<T> {
    return withTenantTx(() => fn());
  }

  async withdraw(
    proposalId: string,
    decidedBy: string,
    note: string
  ): Promise<ProposalRecord | undefined> {
    if (!UUID_RE.test(proposalId)) return undefined;
    // status = 'approved' is the guard: a concurrent consume or withdrawal matches no row. The
    // note keeps who had approved it and when (the same wording as the in-memory store).
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(
        `update proposals
            set status = 'rejected', decided_by = $2,
                decision_note = 'Approved by ' || coalesce(decided_by, 'unknown') || ' at '
                  || coalesce(to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'unknown')
                  || ', never run; withdrawn: ' || $3,
                decided_at = now(), updated_at = now()
          where id = $1::uuid and status = 'approved'
          returning id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
                    actor_identity, effects, effective_risk, payload, observed_version, decided_by,
                    decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at`,
        [proposalId, decidedBy, note]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async supersede(
    proposalIds: readonly string[],
    decidedBy: string,
    note: string
  ): Promise<readonly string[]> {
    const ids = [...new Set(proposalIds)].filter((id) => UUID_RE.test(id));
    if (!ids.length) return [];
    // One statement (review 13 L7). Each row moves only from proposed or approved (the guard, as
    // decide and withdraw); an approved one's note keeps who had approved it and when — the
    // right-hand side reads the row as it was.
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ id: string }>(
        `update proposals
            set status = 'rejected', decided_by = $2,
                decision_note = case when status = 'approved'
                  then 'Approved by ' || coalesce(decided_by, 'unknown') || ' at '
                    || coalesce(to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'unknown')
                    || ', never run; withdrawn: ' || $3
                  else $3 end,
                decided_at = now(), updated_at = now()
          where id = any($1::uuid[]) and status in ('proposed', 'approved')
          returning id`,
        [ids, decidedBy, note]
      )
    );
    return rows.map((r) => r.id);
  }

  async query(options: ProposalQuery): Promise<readonly ProposalRecord[]> {
    // An absent filter is null and matches everything; a null limit is no limit.
    const limit = options.limit && options.limit > 0 ? options.limit : null;
    const { rows } = await withTenantTx((tx) =>
      tx.query<ProposalRow>(
        `select id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role,
                actor_identity, effects, effective_risk, payload, observed_version, decided_by,
                decided_at, decision_note, last_run_error, run_token, run_atomic, created_at, updated_at
           from proposals
          where ($1::text is null or operation_id = $1)
            and ($2::text is null or trajectory_id = $2)
            and ($3::text is null or status = $3)
            and ($5::text[] is null or status = any($5::text[]))
            and ($6::text[] is null or label = any($6::text[]))
            and ($7::text is null or coalesce(payload->>'key', payload->>'configKey') = $7)
            and ($8::uuid[] is null or not (id = any($8::uuid[])))
          order by created_at desc
          limit $4::int`,
        [
          options.operationId || null,
          options.trajectoryId || null,
          options.status || null,
          limit,
          options.statuses ? [...options.statuses] : null,
          options.labels ? [...options.labels] : null,
          options.payloadKey ?? null,
          options.excludeIds?.length
            ? options.excludeIds.filter((id) => UUID_RE.test(id))
            : null,
        ]
      )
    );
    return rows.map(mapRow);
  }
}
