/**
 * platform/admin/hold-expiry.ts — an approval that was never used lapses (review 7 M7)
 *
 * An approved runtime hold runs at once, through its authority. When that run fails (the
 * requester no longer holds the permission, the target is gone), the hold stays approved and is
 * listed so a new approval can run it again. Before: it stayed so for ever — it could neither be
 * rejected (a rejection moves only a proposed hold) nor expire. Now:
 *
 *   - an authorized admin may reject it (ProposalStore.withdraw, recorded like any decision);
 *   - it lapses after the same period as a pending configuration approval,
 *     config.approval_expiry_days (default 7) from its approval: it is no longer listed, a
 *     decision on it answers approvals.expired and withdraws it, and the config.expire-approvals
 *     job withdraws every lapsed one (expireLapsedApprovedHolds).
 *
 * A run claims its approval (approved -> executing, with a fresh run token) and ends it by that
 * token (executed, or approved again when it failed before taking effect: review 10 H2, review 11
 * H-1). A run that did not end within RUN_LEASE_SECONDS — its process died, or it is simply slower
 * than the lease — is taken back by the same job (recoverStaleRuns):
 *
 *   - its step was recorded: it took effect — executed;
 *   - an atomic run (claim, effect and completion one transaction): its effect rolled back with
 *     its claim — approved again (approve again to retry);
 *   - any other: indeterminate (review 11 H-1). Its effect may have happened — the process may
 *     have died between the effect and its record, or the run may still be going — so it is never
 *     approved again by the job (that made a slow run apply twice). It is not runnable; an alert is
 *     raised and a human decides on the approvals page: mark it executed after verifying, or
 *     approve it again (a fresh approval). The run, should it still end, completes it by its token.
 *
 * Each recovery is recorded in its tenant's audit log, in the same statement.
 *
 * Every sweep here takes an optional scope (`tenantIds`): the job passes none and sweeps every
 * tenant; a test passes its own tenants, so a parallel test's rows are never swept by another's
 * run (review 11 L-5). The production job's behaviour is unchanged by the parameter.
 *
 * @module platform/admin
 */

import { getConfigNumber } from "@/platform/auth/platform-config";
import type { Tx } from "@/platform/data";
import type { ProposalRecord } from "@/platform/kernel/types";
import {
  ATOMIC_RECOVERED_NOTE,
  INDETERMINATE_NOTE,
} from "@/platform/agents/proposal-store";
import { raiseAlert } from "@/platform/observability/alert";

/** The approval period, shared with configuration approvals. */
export const APPROVAL_EXPIRY_DAYS_KEY = "config.approval_expiry_days";
const DEFAULT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which tenants a sweep covers: every tenant when `tenantIds` is absent (the job); only those
 * listed otherwise (tests on the owner connection — review 11 L-5).
 */
export interface SweepScope {
  readonly tenantIds?: readonly string[];
}

/** Who withdraws a lapsed approval. */
export const HOLD_EXPIRY_ACTOR = "system:approval-expiry";

/** The approval period in whole days (the default when the setting is unreadable or invalid). */
export async function approvalExpiryDays(): Promise<number> {
  try {
    const days = await getConfigNumber(APPROVAL_EXPIRY_DAYS_KEY, DEFAULT_DAYS);
    return Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_DAYS;
  } catch {
    return DEFAULT_DAYS;
  }
}

/** Whether `proposal` is an approval never used whose period has passed at `now`. */
export function approvalLapsed(
  proposal: ProposalRecord,
  days: number,
  now: number = Date.now()
): boolean {
  if (proposal.status !== "approved" || !proposal.decidedAt) return false;
  const at = Date.parse(proposal.decidedAt);
  return Number.isFinite(at) && at + days * DAY_MS < now;
}

/** The withdrawal note of a lapsed approval. */
export function lapsedNote(days: number): string {
  return `expired: not run within ${days} day${days === 1 ? "" : "s"} of its approval`;
}

/**
 * Withdraw every lapsed approval `tx` can see — on the owner connection (the job), every
 * tenant's. The note keeps who had approved it and when, as ProposalStore.withdraw does. Each
 * withdrawal is recorded in its tenant's audit log, by the system (review 8 L5: the job left no
 * record), in the same statement: no record, no withdrawal.
 */
export async function expireLapsedApprovedHolds(
  tx: Tx,
  days: number,
  scope: SweepScope = {}
): Promise<number> {
  const { rowCount } = await tx.query(
    `with lapsed as (
       select tenant_id, id, decided_by, decided_at
         from proposals
        where status = 'approved' and decided_at < now() - make_interval(days => $1::int)
          and ($4::uuid[] is null or tenant_id = any($4::uuid[]))
        for update
     ),
     withdrawn as (
       update proposals p
          set status = 'rejected', decided_by = $2,
              decision_note = 'Approved by ' || coalesce(l.decided_by, 'unknown') || ' at '
                || coalesce(to_char(l.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'unknown')
                || ', never run; withdrawn: ' || $3,
              decided_at = now(), updated_at = now()
         from lapsed l
        where p.tenant_id = l.tenant_id and p.id = l.id and p.status = 'approved'
        returning p.tenant_id, p.id, p.label, l.decided_by, l.decided_at
     )
     insert into audit_log (tenant_id, action, details)
     select w.tenant_id, 'admin_action'::audit_action,
            jsonb_build_object('type', 'approval_withdrawn', 'reason', 'expired',
                               'holdId', w.id, 'source', 'runtime', 'label', w.label,
                               'approvedBy', w.decided_by, 'approvedAt', w.decided_at,
                               'agent', $2::text, 'outcome', 'succeeded')
       from withdrawn w`,
    [days, HOLD_EXPIRY_ACTOR, lapsedNote(days), scope.tenantIds ?? null]
  );
  return rowCount;
}

/**
 * How long a run may hold its approval (executing) before the job takes it back (review 10 H2):
 * well past any request's run (the statement timeout bounds each database step), short enough
 * that a crashed run's approval is usable again within the hour the job runs on.
 */
export const RUN_LEASE_SECONDS = 600;

/** Who recovers a run that never ended. */
export const RUN_RECOVERY_ACTOR = "system:approval-run-recovery";

/**
 * Take back every run that claimed its approval more than `leaseSeconds` ago and never ended — on
 * the owner connection (the job), every tenant's (or `scope.tenantIds`'). A run whose step was
 * recorded (a commitment step carrying its operation id) took effect: executed. An atomic run's
 * effect rolled back with its claim: approved again. Any other's outcome is unknown:
 * indeterminate — never approved again (review 11 H-1), a human decides. Each recovery is
 * recorded in its tenant's audit log by the system, in the same statement: no record, no
 * recovery. Undecided runs raise an alert. Returns the count recovered.
 */
export async function recoverStaleRuns(
  tx: Tx,
  leaseSeconds: number = RUN_LEASE_SECONDS,
  scope: SweepScope = {}
): Promise<number> {
  const { rows } = await tx.query<{ status: string; n: number }>(
    `with stale as (
       select p.tenant_id, p.id, p.label, p.operation_id, coalesce(p.run_atomic, false) as atomic,
              exists (
                -- The run's trajectory and its continuations (review 11 H-2): the step may have
                -- gone to a segment the trajectory rolled over into. UNION, not UNION ALL (review
                -- 12 L6): a row met again ends the walk, so a cyclic chain — which the chain
                -- guard (052) refuses to create — cannot hang the recovery either.
                with recursive chain(id) as (
                  select t.id from agent_trajectories t
                   where t.tenant_id = p.tenant_id and t.id::text = p.trajectory_id
                  union
                  select c.id from agent_trajectories c join chain on c.previous_trajectory_id = chain.id
                   where c.tenant_id = p.tenant_id
                )
                select 1
                  from agent_trajectories t join chain on t.id = chain.id,
                       jsonb_array_elements(t.steps) s
                 where t.tenant_id = p.tenant_id
                   and s->>'operationId' = p.operation_id
                   and s->>'boundary' = 'commitment'
              ) as recorded
         from proposals p
        where p.status = 'executing'
          and p.updated_at < now() - make_interval(secs => $1::int)
          and ($5::uuid[] is null or p.tenant_id = any($5::uuid[]))
        for update of p
     ),
     recovered as (
       update proposals p
          set status = case when s.recorded then 'executed'
                            when s.atomic then 'approved'
                            else 'indeterminate' end,
              last_run_error = case when s.recorded then p.last_run_error
                                    when s.atomic then $3
                                    else $4 end,
              run_token = case when s.atomic and not s.recorded then null else p.run_token end,
              run_atomic = case when s.atomic and not s.recorded then null else p.run_atomic end,
              updated_at = now()
         from stale s
        where p.tenant_id = s.tenant_id and p.id = s.id and p.status = 'executing'
        returning p.tenant_id, p.id, p.label, p.status
     ),
     audit as (
       insert into audit_log (tenant_id, action, details)
       select r.tenant_id, 'admin_action'::audit_action,
              jsonb_build_object('type', 'approval_run_recovered', 'holdId', r.id,
                                 'label', r.label, 'status', r.status,
                                 'agent', $2::text, 'outcome', 'succeeded')
         from recovered r
     )
     -- A data-modifying WITH runs once whether or not it is read: every recovery is audited.
     select r.status, count(*)::int as n from recovered r group by r.status`,
    [
      leaseSeconds,
      RUN_RECOVERY_ACTOR,
      ATOMIC_RECOVERED_NOTE,
      INDETERMINATE_NOTE,
      scope.tenantIds ?? null,
    ]
  );
  const undecided = rows.find((r) => r.status === "indeterminate")?.n ?? 0;
  if (undecided > 0) {
    raiseAlert({
      name: "approvals.indeterminate",
      message: `${undecided} approved run(s) did not end within their lease; their outcome is unknown. Verify each on the approvals page, then mark it executed or approve it again (docs/runbooks/approvals-and-agents.md).`,
      count: undecided,
    });
  }
  return rows.reduce((sum, r) => sum + r.n, 0);
}
