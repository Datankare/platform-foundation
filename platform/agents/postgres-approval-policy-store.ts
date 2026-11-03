/**
 * platform/agents/postgres-approval-policy-store.ts — Durable approval policy
 * (Sprint 3c A3, ADR-053 D4)
 *
 * ApprovalPolicyStore on Postgres through platform/data, in the request's tenant: each tenant
 * has its own policy history, kept apart by row-level security; tenant_id is filled by its
 * column default. Table: agent_approval_policy (migration 030), append-only and VERSIONED —
 * each setRules INSERTs a new row whose version is the tenant's current max + 1. The table IS
 * the audit trail: every row carries decided_by + created_at, so a policy change is
 * reconstructable (P3/P18) without a separate audit write.
 *
 * Atomicity (the A2 kit's concurrency arm): version is UNIQUE per tenant (049), and the next
 * version and the carried-forward default are computed by the INSERT itself, so two
 * concurrent setRules cannot both claim version N — the loser gets a unique violation and
 * retries against the new max. Atomic in the database, not a read-then-write here.
 *
 * @module platform/agents
 */

import type {
  ApprovalPolicy,
  ApprovalPolicyStore,
  ApprovalRule,
  ActorType,
} from "./approval-policy-store";
import {
  appliedPolicy,
  approvalPolicyProblem,
  DEFAULT_APPROVAL_POLICY,
  POLICY_DEFAULT_APPROVERS,
} from "./approval-policy-store";
import { generateUuid } from "./utils";
import { withSavepoint, withTenantTx } from "@/platform/data";

const MAX_VERSION_CONFLICT_RETRIES = 5;

interface PolicyRow {
  version: number;
  default_approver: string;
  rules: unknown;
}

function mapRow(row: PolicyRow): ApprovalPolicy {
  return {
    version: row.version,
    default: row.default_approver as ActorType,
    rules: (Array.isArray(row.rules) ? row.rules : []) as readonly ApprovalRule[],
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "23505";
}

export class PostgresApprovalPolicyStore implements ApprovalPolicyStore {
  /** The highest-version row, or the behavior-preserving default if the tenant has none. */
  async load(): Promise<ApprovalPolicy> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<PolicyRow>(
        `select version, default_approver, rules from agent_approval_policy
          order by version desc limit 1`
      )
    );
    return rows.length ? appliedPolicy(mapRow(rows[0])) : DEFAULT_APPROVAL_POLICY;
  }

  /**
   * Append a new policy version: (current max + 1, or the default's version + 1 when there is
   * none), with the default actorType given, else the current one carried forward. A unique
   * violation on version means a concurrent writer took it; retry against the new max.
   */
  async setRules(
    rules: readonly ApprovalRule[],
    decidedBy: string,
    defaultApprover?: ActorType
  ): Promise<ApprovalPolicy> {
    const problem = approvalPolicyProblem(rules, defaultApprover);
    if (problem) throw new Error(`approval-policy setRules refused: ${problem}`);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_VERSION_CONFLICT_RETRIES; attempt++) {
      try {
        // Under a savepoint (review 11 L-6): inside a caller's transaction (an atomic approved
        // run joins one) a unique violation would abort the whole transaction, and the retry
        // would run in the aborted one; the savepoint undoes only this attempt.
        const { rows } = await withTenantTx((tx) =>
          withSavepoint(tx, () =>
            tx.query<PolicyRow>(
              `insert into agent_approval_policy (id, version, default_approver, rules, decided_by)
             select $1::uuid,
                    coalesce((select max(version) from agent_approval_policy), $2::int) + 1,
                    coalesce(
                      $6::text,
                      (select case when default_approver = any($7::text[])
                                   then default_approver end
                         from agent_approval_policy order by version desc limit 1),
                      $3),
                    $4::jsonb,
                    $5
             returning version, default_approver, rules`,
              [
                generateUuid(),
                DEFAULT_APPROVAL_POLICY.version,
                DEFAULT_APPROVAL_POLICY.default,
                JSON.stringify(rules),
                decidedBy,
                defaultApprover ?? null,
                // A carried-forward default the store would refuse is not carried (round 12).
                [...POLICY_DEFAULT_APPROVERS],
              ]
            )
          )
        );
        return mapRow(rows[0]);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        lastErr = new Error("approval-policy version conflict", { cause: err });
      }
    }
    throw lastErr ?? new Error("approval-policy setRules: exhausted version retries");
  }
}
