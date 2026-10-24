/**
 * __tests__/helpers/store-isolation-fixtures.ts — tenant isolation fixtures for the agent,
 * app-framework and RAG stores (ADR-053 D8)
 *
 * One fixture set per store interface, run by runTenantIsolationContract against both the
 * in-memory store (memory tenants) and the Postgres store (database tenants). Where a store
 * names its records by a generated id, the fixture remembers the id each key was last written
 * with, so the "B cannot change A's record" arm really aims at A's record.
 */

import { randomUUID } from "node:crypto";
import type { IsolationTenant } from "../contract/tenant-isolation-contract";
import { runWithTenant } from "@/platform/tenancy/context";
import type { EffectLedger, ProposalStore, TrajectoryStore } from "@/platform/kernel";
import type { ApprovalPolicyStore } from "@/platform/agents/approval-policy-store";
import type { ActivityStateStore } from "@/platform/app-framework/state-store";
import type { EmbeddingStore, Scope, UserContextStore } from "@/platform/rag/types";

/** A tenant for in-memory stores: a fresh random tenant id, no database. */
export async function memoryTenant(): Promise<IsolationTenant> {
  const ctx = { tenantId: randomUUID(), mode: "shared" as const };
  return { run: (fn) => runWithTenant(ctx, fn) };
}

export function trajectoryIsolation() {
  const ids = new Map<string, string>();
  return {
    write: async (s: TrajectoryStore, key: string) => {
      const r = await s.create({ kind: "agent", id: key }, "iso", "platform");
      ids.set(key, r.trajectory.trajectoryId);
    },
    read: async (s: TrajectoryStore, key: string) =>
      (await s.query({ subjectId: key }))[0] ?? null,
    update: async (s: TrajectoryStore, key: string) => {
      await s.updateStatus(ids.get(key) as string, "failed");
    },
  };
}

export function proposalIsolation() {
  const ids = new Map<string, string>();
  return {
    write: async (s: ProposalStore, key: string) => {
      const p = await s.create({
        operationId: key,
        sessionId: "iso-session",
        trajectoryId: "iso-trajectory",
        label: "iso",
        actor: { actorType: "agent", actorId: "agent:iso", agentRole: "iso" },
        effects: ["stateWrite"],
        effectiveRisk: "consequential",
      });
      ids.set(key, p.proposalId);
    },
    read: async (s: ProposalStore, key: string) =>
      (await s.query({ operationId: key }))[0] ?? null,
    update: async (s: ProposalStore, key: string) => {
      await s.decide(ids.get(key) as string, "approved", "intruder");
    },
  };
}

export function effectLedgerIsolation() {
  return {
    write: async (l: EffectLedger, key: string) => {
      await l.begin({ operationId: key, effectKey: "iso", effectType: "externalCall" });
    },
    read: async (l: EffectLedger, key: string) => (await l.get(key, "iso")) ?? null,
    update: async (l: EffectLedger, key: string) => {
      await l.resolve(key, "iso", "confirmed");
    },
  };
}

/** A policy "exists" for a tenant once it has moved past the default's version. */
export function approvalPolicyIsolation() {
  return {
    write: async (s: ApprovalPolicyStore, key: string) => {
      await s.setRules([{ maxRisk: "ordinary", requiredApprover: "agent" }], key);
    },
    read: async (s: ApprovalPolicyStore) => {
      const p = await s.load();
      return p.version > 1 ? p : null;
    },
    update: async (s: ApprovalPolicyStore, key: string) => {
      await s.setRules([{ maxRisk: "consequential", requiredApprover: "agent" }], key);
    },
  };
}

export function appStateIsolation() {
  return {
    write: async (s: ActivityStateStore<{ n: number }>, key: string) => {
      await s.create(key, { n: 1 });
    },
    read: async (s: ActivityStateStore<{ n: number }>, key: string) => s.load(key),
    update: async (s: ActivityStateStore<{ n: number }>, key: string) => {
      await s.commit(key, 1, { n: 99 }, "intruder");
    },
    remove: async (s: ActivityStateStore<{ n: number }>, key: string) => s.delete(key),
  };
}

const ISO_SCOPE: Scope = { knowledgeBaseId: "iso-kb", dimensions: {} };
/** pgvector's column is vector(1536), so the fixture vector is that size for every store. */
export const ISO_VECTOR: readonly number[] = Array.from({ length: 1536 }, (_, i) =>
  i === 0 ? 1 : 0
);

export function embeddingIsolation() {
  const chunk = (key: string, content: string) => ({
    id: key,
    documentId: key,
    content,
    index: 0,
    startOffset: 0,
    endOffset: content.length,
    metadata: {},
  });
  return {
    write: async (s: EmbeddingStore, key: string) => {
      await s.upsert(ISO_SCOPE, key, ISO_VECTOR, chunk(key, "original"));
    },
    read: async (s: EmbeddingStore, key: string) =>
      (await s.search(ISO_SCOPE, ISO_VECTOR, 10, 0)).find((r) => r.chunk.id === key) ??
      null,
    update: async (s: EmbeddingStore, key: string) => {
      await s.upsert(ISO_SCOPE, key, ISO_VECTOR, chunk(key, "changed"));
    },
    remove: async (s: EmbeddingStore, key: string) => {
      await s.deleteByDocument(ISO_SCOPE, key);
    },
  };
}

export function userContextIsolation() {
  return {
    write: async (s: UserContextStore, key: string) => {
      await s.updatePreferences(key, { tone: "brief" });
    },
    read: async (s: UserContextStore, key: string) => (await s.getContext(key)) ?? null,
    update: async (s: UserContextStore, key: string) => {
      await s.updatePreferences(key, { tone: "verbose" });
    },
    remove: async (s: UserContextStore, key: string) => s.deleteContext(key),
  };
}
