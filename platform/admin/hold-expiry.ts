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
 * A hold never decided (`proposed`) lapses after the same period from its request (TASK-193,
 * audit B-4: it never expired, and a year-old held role change could still be approved):
 * expireUndecidedHolds withdraws it and ends its trajectory; it is not listed once lapsed, and a
 * decision on it answers approvals.expired. Every withdrawal here ends the hold's trajectory.
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
 * Its workflow waits with it (TASK-173): the run's trajectory, left `running` by the lost run,
 * moves to `indeterminate` (blocked until a person decides) or, for an atomic run approved again,
 * `awaiting_retry` — so the agent's own continuation answers held instead of re-proposing a step
 * whose approval stands (the one-live rule refused that with a plain error: a 500 in a consumer).
 *
 * Each recovery is recorded in its tenant's audit log, in the same statement — with the
 * trajectory it moved, if any.
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
  RECOVERED_TRAJECTORY,
} from "@/platform/agents/proposal-store";
import { workflowTriggers } from "@/platform/agents/trajectory-closure";
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
 * record), in the same statement: no record, no withdrawal. The hold's trajectory ends in the same
 * statement too (TASK-193: it was left awaiting_retry or running for good): every open segment of
 * its chain is `failed`, unless another open hold not withdrawn here is on any segment of it.
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
        returning p.tenant_id, p.id, p.label, p.trajectory_id, l.decided_by, l.decided_at
     ),
     ended as (
       update agent_trajectories t
          set status = 'failed', version = t.version + 1, updated_at = now()
         from withdrawn w
        where t.tenant_id = w.tenant_id
          and t.chain_root_id = (select r.chain_root_id from agent_trajectories r
                                  where r.tenant_id = w.tenant_id and r.id::text = w.trajectory_id)
          and t.status in ('running', 'paused', 'awaiting_retry', 'indeterminate')
          and not exists (
            select 1 from proposals o
             where o.tenant_id = w.tenant_id
               -- Any segment of the chain (review round 1, L4), as the reaper checks.
               and o.trajectory_id in (select c.id::text from agent_trajectories c
                                        where c.tenant_id = t.tenant_id
                                          and c.chain_root_id = t.chain_root_id)
               and o.status in ('proposed', 'approved', 'executing', 'indeterminate')
               and not exists (select 1 from withdrawn x
                                where x.tenant_id = o.tenant_id and x.id = o.id))
       returning t.id
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

/** The withdrawal note of a hold never decided within the period (TASK-193, audit B-4). */
export function undecidedNote(days: number): string {
  return `expired: not decided within ${days} day${days === 1 ? "" : "s"} of being requested`;
}

/**
 * Withdraw every runtime hold still awaiting a decision (`proposed`) `days` after it was requested
 * — the same period, config.approval_expiry_days, as a configuration approval and an unused
 * approval (TASK-193, audit B-4: a held role change could be approved a year later, and a hold no
 * authority owns stayed for ever). On the owner connection (the job), every tenant's (or
 * `scope.tenantIds`'). Withdrawn as a rejection by the system, its trajectory ended in the same
 * statement, each recorded in its tenant's audit log (approval_withdrawn, reason "expired",
 * `decision: "undecided"`): no record, no withdrawal.
 */
export async function expireUndecidedHolds(
  tx: Tx,
  days: number,
  scope: SweepScope = {}
): Promise<number> {
  const { rowCount } = await tx.query(
    `with lapsed as (
       select tenant_id, id
         from proposals
        where status = 'proposed' and created_at < now() - make_interval(days => $1::int)
          and ($4::uuid[] is null or tenant_id = any($4::uuid[]))
        for update
     ),
     withdrawn as (
       update proposals p
          set status = 'rejected', decided_by = $2, decision_note = $3,
              decided_at = now(), updated_at = now()
         from lapsed l
        where p.tenant_id = l.tenant_id and p.id = l.id and p.status = 'proposed'
        returning p.tenant_id, p.id, p.label, p.trajectory_id, p.created_at
     ),
     ended as (
       update agent_trajectories t
          set status = 'failed', version = t.version + 1, updated_at = now()
         from withdrawn w
        where t.tenant_id = w.tenant_id
          and t.chain_root_id = (select r.chain_root_id from agent_trajectories r
                                  where r.tenant_id = w.tenant_id and r.id::text = w.trajectory_id)
          and t.status in ('running', 'paused', 'awaiting_retry', 'indeterminate')
          and not exists (
            select 1 from proposals o
             where o.tenant_id = w.tenant_id
               -- Any segment of the chain (review round 1, L4), as the reaper checks.
               and o.trajectory_id in (select c.id::text from agent_trajectories c
                                        where c.tenant_id = t.tenant_id
                                          and c.chain_root_id = t.chain_root_id)
               and o.status in ('proposed', 'approved', 'executing', 'indeterminate')
               and not exists (select 1 from withdrawn x
                                where x.tenant_id = o.tenant_id and x.id = o.id))
       returning t.id
     )
     insert into audit_log (tenant_id, action, details)
     select w.tenant_id, 'admin_action'::audit_action,
            jsonb_build_object('type', 'approval_withdrawn', 'reason', 'expired',
                               'decision', 'undecided', 'holdId', w.id, 'source', 'runtime',
                               'label', w.label, 'requestedAt', w.created_at,
                               'agent', $2::text, 'outcome', 'succeeded')
       from withdrawn w`,
    [days, HOLD_EXPIRY_ACTOR, undecidedNote(days), scope.tenantIds ?? null]
  );
  return rowCount;
}

/** Whether `proposal` is a hold never decided whose period has passed at `now` (TASK-193). */
export function holdLapsed(
  proposal: ProposalRecord,
  days: number,
  now: number = Date.now()
): boolean {
  if (proposal.status === "approved") return approvalLapsed(proposal, days, now);
  if (proposal.status !== "proposed") return false;
  const at = Date.parse(proposal.createdAt);
  return Number.isFinite(at) && at + days * DAY_MS < now;
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
 * indeterminate — never approved again (review 11 H-1), a human decides. The run's trajectory
 * moves to the matching waiting state (RECOVERED_TRAJECTORY, TASK-173) in the same statement.
 * Each recovery is recorded in its tenant's audit log by the system, in the same statement, with
 * the trajectory moved (`trajectoryId`, `trajectoryFrom`, `trajectoryStatus`; null when none
 * moved): no record, no recovery. Undecided runs raise an alert. Returns the count recovered.
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
              -- Alerted below, now: alertWaitingUndecided reminds of it a day on (L3).
              reminded_at = case when not s.recorded and not s.atomic then now()
                                 else p.reminded_at end,
              updated_at = now()
         from stale s
        where p.tenant_id = s.tenant_id and p.id = s.id and p.status = 'executing'
        returning p.tenant_id, p.id, p.label, p.status, p.trajectory_id
     ),
     -- The run's workflow waits with its approval (TASK-173): only from a status a run leaves it
     -- in, so a finished or already undecided trajectory is left as it is.
     waiting as (
       select t.tenant_id, t.id, t.status as from_status, r.id as hold_id,
              case when r.status = 'indeterminate' then $6::text
                   when r.status = 'executed' then $10::text
                   else $8::text end as to_status
         from recovered r
         join agent_trajectories t
           on t.tenant_id = r.tenant_id and t.id::text = r.trajectory_id
        where (r.status = 'indeterminate' and t.status::text = any($7::text[]))
           or (r.status = 'approved' and t.status::text = any($9::text[]))
           -- Its step was recorded: the request is over (review round 1, L1) — but a
           -- workflow's trajectory (its trigger a workflow goal) is its user's to continue (M1).
           or (r.status = 'executed' and t.status::text = any($11::text[])
               and not (t.trigger = any($12::text[])))
          for update of t
     ),
     moved as (
       update agent_trajectories t
          set status = w.to_status::trajectory_status, version = t.version + 1,
              updated_at = now()
         from waiting w
        where t.tenant_id = w.tenant_id and t.id = w.id
        returning t.tenant_id, t.id, w.hold_id, w.from_status, t.status
     ),
     audit as (
       insert into audit_log (tenant_id, action, details)
       select r.tenant_id, 'admin_action'::audit_action,
              jsonb_build_object('type', 'approval_run_recovered', 'holdId', r.id,
                                 'label', r.label, 'status', r.status,
                                 'trajectoryId', m.id, 'trajectoryFrom', m.from_status,
                                 'trajectoryStatus', m.status,
                                 'agent', $2::text, 'outcome', 'succeeded')
         from recovered r
         left join moved m on m.tenant_id = r.tenant_id and m.hold_id = r.id
     )
     -- A data-modifying WITH runs once whether or not it is read: every recovery is audited.
     select r.status, count(*)::int as n from recovered r group by r.status`,
    [
      leaseSeconds,
      RUN_RECOVERY_ACTOR,
      ATOMIC_RECOVERED_NOTE,
      INDETERMINATE_NOTE,
      scope.tenantIds ?? null,
      RECOVERED_TRAJECTORY.indeterminate.to,
      RECOVERED_TRAJECTORY.indeterminate.from,
      RECOVERED_TRAJECTORY.approved.to,
      RECOVERED_TRAJECTORY.approved.from,
      RECOVERED_TRAJECTORY.executed.to,
      RECOVERED_TRAJECTORY.executed.from,
      await workflowTriggers(),
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

/** How often a run still undecided is alerted again (review round 1, L3): at most daily. */
export const UNDECIDED_REMINDER_HOURS = 24;

/**
 * Raise approvals.indeterminate again while approved runs are still undecided (TASK-193): an
 * undecided run waits for a person (never decided by a job — review 11 H-1), and the alert raised
 * when it was found must not be the only one. Once per run found (recoverStaleRuns raises it and
 * marks the run reminded), then at most every UNDECIDED_REMINDER_HOURS per run (review round 1,
 * L3: every 15-minute run raised it again) — `proposals.reminded_at`. Run by the
 * config.expire-approvals job each time; returns how many are waiting (on the owner connection,
 * every tenant's — or `scope`'s).
 */
export async function alertWaitingUndecided(
  tx: Tx,
  scope: SweepScope = {}
): Promise<number> {
  const { rows } = await tx.query<{ waiting: number; due: number }>(
    `with due as (
       select tenant_id, id from proposals
        where status = 'indeterminate'
          and ($1::uuid[] is null or tenant_id = any($1::uuid[]))
          and (reminded_at is null or reminded_at < now() - make_interval(hours => $2::int))
          for update skip locked
     ),
     reminded as (
       update proposals p set reminded_at = now()
         from due d where p.tenant_id = d.tenant_id and p.id = d.id
       returning p.id
     )
     select (select count(*)::int from proposals
              where status = 'indeterminate'
                and ($1::uuid[] is null or tenant_id = any($1::uuid[]))) as waiting,
            (select count(*)::int from reminded) as due`,
    [scope.tenantIds ?? null, UNDECIDED_REMINDER_HOURS]
  );
  const waiting = rows[0]?.waiting ?? 0;
  if ((rows[0]?.due ?? 0) > 0) {
    raiseAlert({
      name: "approvals.indeterminate",
      message: `${waiting} approved run(s) are still undecided: whether each took effect is unknown. Verify each on the approvals page, then mark it executed or approve it again (docs/runbooks/approvals-and-agents.md).`,
      count: waiting,
    });
  }
  return waiting;
}
