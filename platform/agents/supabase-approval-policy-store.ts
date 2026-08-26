/**
 * platform/agents/supabase-approval-policy-store.ts — Durable approval policy (Sprint 3c A3)
 *
 * Raw fetch against /rest/v1/, the SupabaseProposalStore pattern (not the JS client, per
 * TASK-066). Table: agent_approval_policy (migration 030), append-only and VERSIONED — each
 * setRules INSERTs a new row whose version is the current max + 1. The table IS the audit
 * trail: every row carries decided_by + created_at, so a policy change is reconstructable
 * (P3/P18) without a separate audit write.
 *
 * Atomicity (the A2 kit's concurrency arm): version carries a UNIQUE constraint, so two
 * concurrent setRules cannot both claim version N — the loser gets a 409 and retries against
 * the new max. This is atomic in the database, not a read-then-write here (the TASK-063
 * lesson, mirrored from SupabaseProposalStore.decide).
 *
 * @module platform/agents
 */

import type {
  ApprovalPolicy,
  ApprovalPolicyStore,
  ApprovalRule,
  ActorType,
} from "./approval-policy-store";
import { DEFAULT_APPROVAL_POLICY } from "./approval-policy-store";
import { generateUuid } from "./utils";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const TABLE = "agent_approval_policy";
const MAX_VERSION_CONFLICT_RETRIES = 5;

interface PolicyRow {
  id: string;
  version: number;
  default_approver: string;
  rules: unknown;
  decided_by: string;
  created_at: string;
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

function mapRow(row: PolicyRow): ApprovalPolicy {
  return {
    version: row.version,
    default: row.default_approver as ActorType,
    rules: (Array.isArray(row.rules) ? row.rules : []) as readonly ApprovalRule[],
  };
}

export class SupabaseApprovalPolicyStore implements ApprovalPolicyStore {
  private readonly url: string;
  private readonly key: string;

  constructor(url: string, serviceKey: string) {
    this.url = url.replace(/\/+$/, "");
    this.key = serviceKey;
  }

  private endpoint(query = ""): string {
    return `${this.url}/rest/v1/${TABLE}${query}`;
  }

  /** The highest-version row, or the behavior-preserving default if the table is empty. */
  async load(): Promise<ApprovalPolicy> {
    const res = await fetchWithTimeout(
      this.endpoint("?order=version.desc&limit=1&select=*"),
      { headers: headers(this.key) }
    );
    if (!res.ok) {
      throw new Error(`approval-policy load failed: ${res.status}`);
    }
    const rows = (await res.json()) as PolicyRow[];
    if (!rows || rows.length === 0) return DEFAULT_APPROVAL_POLICY;
    return mapRow(rows[0]);
  }

  private async currentMaxVersion(): Promise<number> {
    const res = await fetchWithTimeout(
      this.endpoint("?order=version.desc&limit=1&select=version"),
      { headers: headers(this.key) }
    );
    if (!res.ok) {
      throw new Error(`approval-policy version read failed: ${res.status}`);
    }
    const rows = (await res.json()) as Array<{ version: number }>;
    return rows && rows.length > 0 ? rows[0].version : DEFAULT_APPROVAL_POLICY.version;
  }

  /**
   * Append a new policy version. Version is (current max + 1); a UNIQUE constraint on version
   * makes a concurrent claim fail with 409, which we retry against the new max — atomic in
   * the DB. The default actorType is carried forward from the current policy.
   */
  async setRules(
    rules: readonly ApprovalRule[],
    decidedBy: string
  ): Promise<ApprovalPolicy> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_VERSION_CONFLICT_RETRIES; attempt++) {
      const current = await this.load();
      const nextVersion = (await this.currentMaxVersion()) + 1;
      const body = {
        id: generateUuid(),
        version: nextVersion,
        default_approver: current.default,
        rules,
        decided_by: decidedBy,
        created_at: new Date().toISOString(),
      };
      const res = await fetchWithTimeout(this.endpoint(), {
        method: "POST",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const inserted = (await res.json()) as PolicyRow[];
        return mapRow(inserted[0]);
      }
      // 409 = unique_violation on version: another writer took this version. Retry.
      if (res.status === 409) {
        lastErr = new Error("approval-policy version conflict");
        continue;
      }
      throw new Error(`approval-policy setRules failed: ${res.status}`);
    }
    throw lastErr ?? new Error("approval-policy setRules: exhausted version retries");
  }
}
