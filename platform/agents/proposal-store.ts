/**
 * platform/agents/proposal-store.ts — Proposal persistence (ADR-031 D2)
 *
 * In-memory implementation and the singleton. The contract lives in platform/kernel because
 * the action pipeline creates and decides proposals and cannot import platform/agents
 * (ADR-029 D2).
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

export type {
  CreateProposalArgs,
  ProposalQuery,
  ProposalRecord,
  ProposalStatus,
  ProposalStore,
} from "@/platform/kernel";

export class InMemoryProposalStore implements ProposalStore {
  private records: ProposalRecord[] = [];

  async create(args: CreateProposalArgs): Promise<ProposalRecord> {
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
    this.records.push(record);
    return record;
  }

  async getById(proposalId: string): Promise<ProposalRecord | undefined> {
    return this.records.find((r) => r.proposalId === proposalId);
  }

  async decide(
    proposalId: string,
    status: Exclude<ProposalStatus, "proposed">,
    decidedBy: string,
    note?: string
  ): Promise<ProposalRecord | undefined> {
    const i = this.records.findIndex((r) => r.proposalId === proposalId);
    if (i === -1) return undefined;
    // Only from `proposed`. A second decision on the same proposal is a no-op returning
    // undefined, so a caller can distinguish "I decided this" from "someone already had"
    // (ADR-031 D4).
    if (this.records[i].status !== "proposed") return undefined;

    const now = new Date().toISOString();
    const updated: ProposalRecord = {
      ...this.records[i],
      status,
      decidedBy,
      decidedAt: now,
      decisionNote: note,
      updatedAt: now,
    };
    this.records[i] = updated;
    return updated;
  }

  async query(options: ProposalQuery): Promise<readonly ProposalRecord[]> {
    let out = [...this.records];
    if (options.operationId)
      out = out.filter((r) => r.operationId === options.operationId);
    if (options.trajectoryId)
      out = out.filter((r) => r.trajectoryId === options.trajectoryId);
    if (options.status) out = out.filter((r) => r.status === options.status);
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options.limit && options.limit > 0) out = out.slice(0, options.limit);
    return out;
  }

  clear(): void {
    this.records = [];
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
