/**
 * platform/agents/supabase-proposal-store.ts — Durable proposals
 *
 * Raw fetch against /rest/v1/, the SupabaseTrajectoryStore pattern. Not the JS client: a
 * raw-fetch store is exercisable by its conformance kit against a PostgREST fake, and the
 * one store here built on createClient shipped dead for a sprint (TASK-066).
 *
 * Table: proposals (migration 027).
 *
 * `decide` is conditional on status='proposed' in the WHERE clause, so a second decision
 * matches no row and returns undefined — atomic in the database rather than in a
 * read-then-write here (ADR-031 D4, and the lesson of TASK-063).
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
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const TABLE = "proposals";

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
  actor_identity?: unknown;
  effects: unknown;
  effective_risk: string;
  payload: unknown;
  observed_version: number | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
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
    decidedAt: row.decided_at ?? undefined,
    decisionNote: row.decision_note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseProposalStore implements ProposalStore {
  private readonly url: string;
  private readonly key: string;

  constructor(url: string, serviceKey: string) {
    this.url = url.replace(/\/+$/, "");
    this.key = serviceKey;
  }

  private endpoint(query = ""): string {
    return `${this.url}/rest/v1/${TABLE}${query}`;
  }

  async create(args: CreateProposalArgs): Promise<ProposalRecord> {
    const now = new Date().toISOString();
    const body = {
      id: generateUuid(),
      operation_id: args.operationId,
      session_id: args.sessionId,
      trajectory_id: args.trajectoryId,
      label: args.label,
      status: "proposed",
      actor_id: args.actor.actorId,
      actor_role: args.actor.agentRole,
      actor_identity: args.actor,
      effects: args.effects,
      effective_risk: args.effectiveRisk,
      payload: args.payload ?? {},
      observed_version: args.observedVersion ?? null,
      created_at: now,
      updated_at: now,
    };
    const res = await fetchWithTimeout(this.endpoint(), {
      timeoutMs: 10_000,
      // Retry is the caller's: reduceCommit loops on version conflict and the effect
      // ledger owns at-most-once. A transport retrying a PATCH underneath either can
      // double-apply a committed write (ADR-028 D5, ADR-031 D7).
      maxRetries: 0,
      method: "POST",
      headers: headers(this.key, "return=representation"),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `agents: proposal create failed (${res.status}): ${await res.text()}`
      );
    }
    const rows = (await res.json()) as ProposalRow[];
    if (!rows.length) throw new Error("agents: proposal create returned no row");
    return mapRow(rows[0]);
  }

  async getById(proposalId: string): Promise<ProposalRecord | undefined> {
    const res = await fetchWithTimeout(
      this.endpoint(`?id=eq.${encodeURIComponent(proposalId)}`),
      {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        method: "GET",
        headers: headers(this.key),
      }
    );
    if (!res.ok) {
      throw new Error(
        `agents: proposal read failed (${res.status}): ${await res.text()}`
      );
    }
    const rows = (await res.json()) as ProposalRow[];
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async decide(
    proposalId: string,
    status: Exclude<ProposalStatus, "proposed" | "executed">,
    decidedBy: string,
    note?: string
  ): Promise<ProposalRecord | undefined> {
    // status=eq.proposed is the guard: a second decision matches no row.
    const res = await fetchWithTimeout(
      this.endpoint(`?id=eq.${encodeURIComponent(proposalId)}&status=eq.proposed`),
      {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        method: "PATCH",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({
          status,
          decided_by: decidedBy,
          decision_note: note ?? null,
          decided_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `agents: proposal decide failed (${res.status}): ${await res.text()}`
      );
    }
    const rows = (await res.json()) as ProposalRow[];
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async consume(proposalId: string): Promise<ProposalRecord | undefined> {
    // status=eq.approved is the claim: a second consume, or a concurrent one, matches no row.
    const res = await fetchWithTimeout(
      this.endpoint(`?id=eq.${encodeURIComponent(proposalId)}&status=eq.approved`),
      {
        timeoutMs: 10_000,
        // A retried PATCH could not double-claim (the filter guards it), but the caller must
        // learn whether IT claimed: no transport retry.
        maxRetries: 0,
        method: "PATCH",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({
          status: "executed",
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `agents: proposal consume failed (${res.status}): ${await res.text()}`
      );
    }
    const rows = (await res.json()) as ProposalRow[];
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async query(options: ProposalQuery): Promise<readonly ProposalRecord[]> {
    const params: string[] = [];
    if (options.operationId)
      params.push(`operation_id=eq.${encodeURIComponent(options.operationId)}`);
    if (options.trajectoryId)
      params.push(`trajectory_id=eq.${encodeURIComponent(options.trajectoryId)}`);
    if (options.status) params.push(`status=eq.${encodeURIComponent(options.status)}`);
    params.push("order=created_at.desc");
    if (options.limit && options.limit > 0) params.push(`limit=${options.limit}`);

    const res = await fetchWithTimeout(this.endpoint(`?${params.join("&")}`), {
      timeoutMs: 10_000,
      // Retry is the caller's: reduceCommit loops on version conflict and the effect
      // ledger owns at-most-once. A transport retrying a PATCH underneath either can
      // double-apply a committed write (ADR-028 D5, ADR-031 D7).
      maxRetries: 0,
      method: "GET",
      headers: headers(this.key),
    });
    if (!res.ok) {
      throw new Error(
        `agents: proposal query failed (${res.status}): ${await res.text()}`
      );
    }
    return ((await res.json()) as ProposalRow[]).map(mapRow);
  }
}
