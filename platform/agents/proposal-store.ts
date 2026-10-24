/**
 * platform/agents/proposal-store.ts — Proposal persistence (ADR-031 D2)
 *
 * In-memory implementation and the singleton. The contract lives in platform/kernel because
 * the action pipeline creates and decides proposals and cannot import platform/agents
 * (ADR-029 D2). The in-memory store keeps each tenant's proposals in its own partition, as
 * row-level security does for PostgresProposalStore (ADR-053 D6).
 *
 * @module platform/agents
 */

import type {
  CreateProposalArgs,
  ProposalQuery,
  ProposalRecord,
  ProposalStatus,
  ProposalStore,
} from "@/platform/kernel";
import { generateUuid } from "./utils";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";

export type {
  CreateProposalArgs,
  ProposalQuery,
  ProposalRecord,
  ProposalStatus,
  ProposalStore,
} from "@/platform/kernel";

const ONE_LIVE: ReadonlySet<ProposalStatus> = new Set([
  "proposed",
  "approved",
  "executed",
]);

export class InMemoryProposalStore implements ProposalStore {
  /** proposalId → record, per tenant. Insertion order is creation order. */
  private readonly parts = new TenantPartitionedMap<string, ProposalRecord>();

  async create(args: CreateProposalArgs): Promise<ProposalRecord> {
    const records = this.parts.current();
    // As the database's idx_proposals_tenant_one_live (migrations 046, 049): at most one
    // proposal per operation in a tenant that is open, approved or used.
    if (
      [...records.values()].some(
        (r) => r.operationId === args.operationId && ONE_LIVE.has(r.status)
      )
    ) {
      throw new Error(
        `agents: operation ${args.operationId} already has an open, approved or used proposal`
      );
    }
    const now = new Date().toISOString();
    const record: ProposalRecord = {
      proposalId: generateUuid(),
      operationId: args.operationId,
      sessionId: args.sessionId,
      trajectoryId: args.trajectoryId,
      label: args.label,
      status: "proposed",
      actor: args.actor,
      effects: args.effects,
      effectiveRisk: args.effectiveRisk,
      payload: args.payload ?? {},
      observedVersion: args.observedVersion,
      createdAt: now,
      updatedAt: now,
    };
    records.set(record.proposalId, record);
    return record;
  }

  async getById(proposalId: string): Promise<ProposalRecord | undefined> {
    return this.parts.current().get(proposalId);
  }

  async decide(
    proposalId: string,
    status: Exclude<ProposalStatus, "proposed" | "executed">,
    decidedBy: string,
    note?: string
  ): Promise<ProposalRecord | undefined> {
    const records = this.parts.current();
    const current = records.get(proposalId);
    if (!current) return undefined;
    // Only from `proposed`. A second decision on the same proposal is a no-op returning
    // undefined, so a caller can distinguish "I decided this" from "someone already had"
    // (ADR-031 D4).
    if (current.status !== "proposed") return undefined;

    const now = new Date().toISOString();
    const updated: ProposalRecord = {
      ...current,
      status,
      decidedBy,
      decidedAt: now,
      decisionNote: note,
      updatedAt: now,
    };
    records.set(proposalId, updated);
    return updated;
  }

  async consume(proposalId: string): Promise<ProposalRecord | undefined> {
    const records = this.parts.current();
    const current = records.get(proposalId);
    if (!current || current.status !== "approved") return undefined;
    const updated: ProposalRecord = {
      ...current,
      status: "executed",
      updatedAt: new Date().toISOString(),
    };
    records.set(proposalId, updated);
    return updated;
  }

  async query(options: ProposalQuery): Promise<readonly ProposalRecord[]> {
    let out = [...this.parts.current().values()];
    if (options.operationId)
      out = out.filter((r) => r.operationId === options.operationId);
    if (options.trajectoryId)
      out = out.filter((r) => r.trajectoryId === options.trajectoryId);
    if (options.status) out = out.filter((r) => r.status === options.status);
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options.limit && options.limit > 0) out = out.slice(0, options.limit);
    return out;
  }

  /** Forget every tenant's proposals (tests). */
  clear(): void {
    this.parts.clearAll();
  }
}

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const PROPOSALSTORE_KEY = "platform.agents.proposalStore";
function readCurrentStore(): ProposalStore {
  return getSingleton<ProposalStore>(
    PROPOSALSTORE_KEY,
    () => new InMemoryProposalStore()
  );
}
function writeCurrentStore(next: ProposalStore): void {
  setSingleton<ProposalStore>(PROPOSALSTORE_KEY, next);
}

export function getProposalStore(): ProposalStore {
  return readCurrentStore();
}

export function setProposalStore(store: ProposalStore): ProposalStore {
  const previous = readCurrentStore();
  writeCurrentStore(store);
  return previous;
}

export function resetProposalStore(): void {
  writeCurrentStore(new InMemoryProposalStore());
}
