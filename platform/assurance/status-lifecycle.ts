/**
 * platform/assurance/status-lifecycle.ts — every state of every status column, and what ends it
 * (TASK-193)
 *
 * The October 2026 lifecycle audit (class B) found rows that live for ever because a state had no
 * way out: trajectories left `running` by every admin caller (B-1), holds whose trajectory stayed
 * `paused` after the hold ended (B-2), runtime pauses nothing resumes (B-3), holds never decided
 * (B-4), approved configuration changes never applied (B-9), children's accounts pending consent
 * (B-10). The checks that existed tested that a job existed, not that every state had a way out.
 *
 * Here every status column of the schema — a column named `status`, `*_status` or `state`, found
 * in the replayed database — is classified, state by state:
 *
 *   rest      the row may stay in it: an end state, or a steady one — with the reason;
 *   reaper    a recurring job moves rows out of it (or deletes them) once they are past a bound:
 *             the job kind, the function it runs, and the bound (a governed key or a constant);
 *             `waitsOn` when a person normally ends it first (a hold's decider, a workflow's user,
 *             a parent) — the reaper is then the backstop, never the expected way out;
 *   expires   it lapses by a column the readers compare (an expiry checked when it is read);
 *   waits     a person must act, and it is listed where they do — with where, and its alert;
 *   deferred  a known gap, filed: the finding or task that closes it.
 *
 * __tests__/status-lifecycle-registry.test.ts holds this register to the code (every reaper's job
 * is a registered job kind, its function exists and is tagged `@scheduled` with it);
 * __tests__/db/status-lifecycle.db.test.ts holds it to the schema (every status column and every
 * value its enum or check allows is here, nothing here is missing from it) and ages one row in
 * each reaped state past its bound, runs the job, and requires the row moved or gone. A column
 * that is not a lifecycle (a snapshot, a document) is listed in NOT_A_LIFECYCLE with why.
 *
 * Retention of rows at rest is a separate register (rows in a `rest` state are kept until their
 * table's retention removes them); this one is only about getting out of the states that are not.
 *
 * @module platform/assurance
 */

export type StateLifecycle =
  | { readonly rest: string }
  | {
      readonly reaper: string;
      /** "<file>#<function>" the job runs for this state. */
      readonly fn: string;
      /** A governed key, or a constant named in the code, that bounds the state. */
      readonly bound: string;
      /**
       * A person ends it first, normally (review round 1, L6): who, and where — the reaper is the
       * backstop for the one nobody acts on. Absent: no one is waited on (a crash, a lease).
       */
      readonly waitsOn?: string;
    }
  | { readonly expires: string; readonly reason: string }
  | { readonly waits: string; readonly reason: string }
  | { readonly deferred: string; readonly reason: string };

/** "<table>.<column>" → state → its lifecycle. */
export const STATUS_LIFECYCLE: Readonly<
  Record<string, Readonly<Record<string, StateLifecycle>>>
> = {
  // App sessions' trajectories are their sessions' (audit B-5, batch S4 of the TASK-193 sweep):
  // the reaper skips them.
  "agent_trajectories.status": {
    running: {
      reaper: "agents.trajectory-retention",
      fn: "platform/agents/trajectory-retention.ts#applyTrajectoryRetention",
      bound:
        "agent.trajectory.abandon_after_hours (a workflow's: agent.workflow.abandon_after_days)",
    },
    paused: {
      reaper: "agents.trajectory-retention",
      fn: "platform/agents/trajectory-retention.ts#applyTrajectoryRetention",
      bound:
        "agent.trajectory.abandon_after_hours (a workflow's: agent.workflow.abandon_after_days)",
      waitsOn:
        "the hold's decider (the approvals page) while a hold is open — never reaped then; a workflow's user, who continues it",
    },
    awaiting_retry: {
      reaper: "agents.trajectory-retention",
      fn: "platform/agents/trajectory-retention.ts#applyTrajectoryRetention",
      bound:
        "agent.trajectory.abandon_after_hours (a workflow's: agent.workflow.abandon_after_days)",
      waitsOn: "the hold's decider, to approve its run again (the approvals page)",
    },
    indeterminate: {
      reaper: "agents.trajectory-retention",
      fn: "platform/agents/trajectory-retention.ts#applyTrajectoryRetention",
      bound:
        "agent.trajectory.abandon_after_hours (a workflow's: agent.workflow.abandon_after_days)",
      waitsOn:
        "a person, to mark its undecided run executed or approve it again (the approvals page) — never reaped while that hold is open",
    },
    completed: {
      rest: "an end state; deleted after agent.trajectory.retention_days (agents.trajectory-retention)",
    },
    failed: {
      rest: "an end state; deleted after agent.trajectory.retention_days (agents.trajectory-retention)",
    },
  },
  "proposals.status": {
    proposed: {
      reaper: "config.expire-approvals",
      fn: "platform/admin/config-approval.ts#expireStaleApprovals",
      bound: "config.approval_expiry_days",
      waitsOn: "a decider, to approve or reject it (the approvals page)",
    },
    approved: {
      reaper: "config.expire-approvals",
      fn: "platform/admin/config-approval.ts#expireStaleApprovals",
      bound: "config.approval_expiry_days",
      waitsOn: "its requester, to run it (or the decider, to withdraw it)",
    },
    executing: {
      reaper: "config.expire-approvals",
      fn: "platform/admin/config-approval.ts#expireStaleApprovals",
      bound: "RUN_LEASE_SECONDS",
    },
    indeterminate: {
      waits:
        "the approvals page (mark executed or approve again); alert approvals.indeterminate, raised again by every config.expire-approvals run while one is waiting",
      reason:
        "an approved run's outcome is unknown: deciding it without a person could apply it twice or record a change that never happened (review 11 H-1)",
    },
    rejected: { rest: "an end state (a decision or a withdrawal)" },
    superseded: { rest: "an end state (revised, or withdrawn when its key was reduced)" },
    executed: { rest: "an end state: the approved action ran" },
  },
  "config_pending_approvals.status": {
    pending: {
      expires: "expires_at",
      reason:
        "refused as expired when decided after it, and marked expired by config.expire-approvals (expireStaleApprovals)",
    },
    approved: {
      reaper: "config.expire-approvals",
      fn: "platform/admin/config-approval.ts#expireStaleApprovals",
      bound: "APPLY_LEASE_SECONDS",
    },
    rejected: { rest: "an end state" },
    expired: { rest: "an end state" },
  },
  "users.parental_consent_status": {
    not_required: { rest: "no consent is needed" },
    granted: { rest: "consent given" },
    // Only while coppa.consent_expiry_enabled is on (off until the parental-consent flow ships:
    // review round 1, item 4) — until then a pending or denied account is kept as it was.
    pending: {
      reaper: "gdpr.retention-purge",
      fn: "platform/auth/coppa.ts#expireParentalConsent",
      bound: "coppa.consent_expiry_days (while coppa.consent_expiry_enabled)",
      waitsOn: "the child's parent, to give consent",
    },
    denied: {
      reaper: "gdpr.retention-purge",
      fn: "platform/auth/coppa.ts#expireParentalConsent",
      bound: "coppa.consent_expiry_days (while coppa.consent_expiry_enabled)",
    },
  },
  "users.account_status": {
    active: { rest: "a steady state" },
    warned: { rest: "a steady state: a warning on record, no restriction" },
    restricted: {
      reaper: "accounts.expire-restrictions",
      fn: "platform/auth/account-status-guard.ts#expireLapsedAccountStatuses",
      bound: "users.restricted_until",
    },
    suspended: {
      reaper: "accounts.expire-restrictions",
      fn: "platform/auth/account-status-guard.ts#expireLapsedAccountStatuses",
      bound: "users.suspended_until",
    },
    banned: {
      rest: "a moderation decision; lifted only by a person (an appeal or an admin)",
    },
  },
  "review_queue.status": {
    pending: {
      waits:
        "the review queue (moderators); an escalation past its SLA is remedied by moderation.escalation-reaper",
      reason: "a moderation decision is a person's",
    },
    claimed: {
      reaper: "moderation.release-claims",
      fn: "platform/moderation/review-service.ts#releaseExpiredClaims",
      bound: "moderation.review_claim_timeout_hours",
    },
    resolved: { rest: "an end state" },
  },
  "jobs.status": {
    queued: {
      reaper: "the job runner",
      fn: "platform/jobs/runner.ts#runDue",
      bound: "run_at",
    },
    running: {
      reaper: "the job runner",
      fn: "platform/jobs/runner.ts#runDue",
      bound: "locked_until (the claim takes back an expired lease, migration 050)",
    },
    succeeded: {
      rest: "an end state; deleted after jobs.retention_days (jobs.prune)",
    },
    dead: {
      waits: "the operator console's jobs page (replay or discard)",
      reason:
        "a job that failed every attempt needs a person to say whether to run it again",
    },
    parked: {
      rest: "its tenant is suspended or deleted: unparked when the tenant is active again, removed by the tenant's purge",
    },
  },
  "job_schedule_outcomes.status": {
    succeeded: { rest: "the schedule's last outcome, replaced by the next run's" },
    retrying: { rest: "the schedule's last outcome, replaced by the next run's" },
    dead: { rest: "the schedule's last outcome, replaced by the next run's" },
  },
  "tenants.status": {
    active: { rest: "a steady state" },
    suspended: { rest: "an operator's decision; lifted by an operator" },
    deleted: {
      reaper: "tenancy.purge-due",
      fn: "platform/tenancy/admin.ts#purgeDueTenants",
      bound: "tenants.purge_after",
    },
  },
  "tenant_lifecycle_requests.status": {
    pending: {
      expires: "expires_at",
      reason: "decided only before it: a decision after it marks the request expired",
    },
    executed: { rest: "an end state" },
    rejected: { rest: "an end state" },
    expired: { rest: "an end state" },
  },
  "purge_log.status": {
    pending: { rest: "never written: a purge's record is written once, when it ends" },
    "in-progress": {
      rest: "never written: a purge's record is written once, when it ends",
    },
    completed: { rest: "the record of an erasure, which must outlive it" },
    failed: {
      rest: "the record of an erasure attempt; its account stays due in user_deletions",
    },
    partial: {
      rest: "the record of an erasure attempt; its account stays due in user_deletions",
    },
  },
  "effect_ledger.status": {
    pending: {
      deferred: "B-12 (TASK-193 sweep, batch S4)",
      reason: "no tool declares an external effect yet in either repository (latent)",
    },
    indeterminate: {
      deferred: "B-12 (TASK-193 sweep, batch S4)",
      reason: "no tool declares an external effect yet in either repository (latent)",
    },
    confirmed: { rest: "a receipt of an external call that took effect" },
    failed: { rest: "a receipt of an external call that did not take effect" },
  },
  "group_invites.status": {
    pending: {
      deferred: "X-25 (Wave 3)",
      reason: "social groups are latent: no route creates an invite yet",
    },
    accepted: { rest: "an end state" },
    declined: { rest: "an end state" },
    expired: { rest: "an end state" },
  },
  "groups.status": {
    active: { rest: "a steady state" },
    archived: { rest: "an owner's decision" },
    suspended: { rest: "a moderator's decision" },
  },
};

/** Status-named columns that are not a lifecycle, with why. */
export const NOT_A_LIFECYCLE: Readonly<Record<string, string>> = {
  "app_sessions.state": "a session's application state (a document), not a status",
  "review_queue.previous_account_status":
    "a snapshot of the account's status before a decision, restored on overturn",
};
