-- ============================================================================
-- 053_trajectory_awaiting_retry.sql — a workflow whose approved step failed before taking
-- effect stays resumable (TASK-170)
--
-- An approved step's run that fails before its effect keeps its approval (review 10 H2:
-- ApprovedRunFailedError, "approve it again to retry"). The workflow loop used to end the
-- trajectory with it (`failed`), and a failed trajectory is never continued — so for an agent
-- workflow "approve it again" could not be done. The trajectory now waits in `awaiting_retry`:
-- approving that step again resumes it at that step, once; a withdrawal or rejection ends it.
-- (A run whose approval could not be given back is `indeterminate` until a person decides it.)
--
-- trajectory_status is an ENUM, so widening is ALTER TYPE ADD VALUE — irreversible (Postgres
-- has no DROP VALUE), and the new value is not used in this migration's own transaction.
-- Retention (deleteFinishedBefore) deletes completed and failed trajectories only, so an
-- awaiting one is kept.
--
-- Idempotent and re-runnable.
-- ============================================================================

alter type public.trajectory_status add value if not exists 'awaiting_retry';

comment on type public.trajectory_status is
  'Trajectory lifecycle. `indeterminate` means an external effect (or an approved run) neither confirmed nor denied and MUST NOT be reported as completed (ADR-029 D10). `awaiting_retry` means an approved step failed before taking effect with its approval kept: approving it again resumes it, once (migration 053).';

insert into public.applied_migrations (filename, confidence, note)
values (
  '053_trajectory_awaiting_retry.sql',
  'verified',
  'trajectory_status awaiting_retry: a workflow whose approved step failed before taking effect stays resumable by approving it again (TASK-170).'
)
on conflict (filename) do nothing;
