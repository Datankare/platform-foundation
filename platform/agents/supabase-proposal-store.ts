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

function mapRow(row: ProposalRow): ProposalRecord {
  const actor: AgentIdentity = {
    actorType: "agent",
    actorId: row.actor_id,
    agentRole: row.actor_role,
  };
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
      effects: args.effects,
      effective_risk: args.effectiveRisk,
      payload: args.payload ?? {},
      observed_version: args.observedVersion ?? null,
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
        `agents: proposal create failed (${res.status}): ${await res.text()}`
      );
    }
    const rows = (await res.json()) as ProposalRow[];
    if (!rows.length) throw new Error("agents: proposal create returned no row");
    return mapRow(rows[0]);
  }

  async getById(proposalId: string): Promise<ProposalRecord | undefined> {
    const res = await fetch(this.endpoint(`?id=eq.${encodeURIComponent(proposalId)}`), {
      method: "GET",
      headers: headers(this.key),
    });
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
    status: Exclude<ProposalStatus, "proposed">,
    decidedBy: string,
    note?: string
  ): Promise<ProposalRecord | undefined> {
    // status=eq.proposed is the guard: a second decision matches no row.
    const res = await fetch(
      this.endpoint(`?id=eq.${encodeURIComponent(proposalId)}&status=eq.proposed`),
      {
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

  async query(options: ProposalQuery): Promise<readonly ProposalRecord[]> {
    const params: string[] = [];
    if (options.operationId)
      params.push(`operation_id=eq.${encodeURIComponent(options.operationId)}`);
    if (options.trajectoryId)
      params.push(`trajectory_id=eq.${encodeURIComponent(options.trajectoryId)}`);
    if (options.status) params.push(`status=eq.${encodeURIComponent(options.status)}`);
    params.push("order=created_at.desc");
    if (options.limit && options.limit > 0) params.push(`limit=${options.limit}`);

    const res = await fetch(this.endpoint(`?${params.join("&")}`), {
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
