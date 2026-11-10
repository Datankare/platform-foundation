/**
 * platform/jobs/retention.ts — how long every table's rows are kept (N-25, TASK-203)
 *
 * Storage limitation asks of every table: how long is a row kept, and why. Only three tables had a
 * rule (erasures, finished trajectories, the job history); audit records kept a live user's IP
 * address for good, and no table was required to answer (S3-E4). RETENTION_REGISTER answers for
 * every platform table — a rule (its age, what happens then, and who applies it) or the reason it
 * is kept — and __tests__/db/retention-coverage.db.test.ts fails on a table of the schema that has
 * no entry (the platform's here; an app's own tables in its platform/modules/app-manifest.json
 * "retention").
 *
 * The rules no other duty applies are RETENTION_RULES, applied by the data.retention job in every
 * tenant (suspended ones too: storage limitation does not pause) — each a fixed statement over its
 * table (no SQL built from values: the cutoff and the batch are bound), its age a governed setting
 * (retention.*, migration 064: operator-only, bounded, the job dual-controlled). A row's whole
 * account is erased with it by the erasure register (platform/auth/user-data.ts), whatever its age:
 * this is the limit for a live account's rows.
 *
 * @module platform/jobs
 */

import { getConfigNumber } from "@/platform/auth/platform-config";
import { withTenantTx } from "@/platform/data";

/** One table's retention: a rule, or why its rows are kept. */
export type RetentionEntry =
  | {
      readonly kind: "rule";
      /** What happens to a row, and when. */
      readonly rule: string;
      /** Who applies it: a job kind, or the database itself. */
      readonly by: string;
    }
  | {
      readonly kind: "keep";
      /** Why the rows stay (for as long as the account or the deployment, as it says). */
      readonly why: string;
    };

const ERASED =
  "erased with the account (platform/auth/user-data.ts), and otherwise kept while the account exists";

/** Every platform table's retention (the coverage test holds it to the schema). */
export const RETENTION_REGISTER: Readonly<Record<string, RetentionEntry>> = {
  // ── Rules applied by a job ────────────────────────────────────────────────────────────────
  agent_trajectories: {
    kind: "rule",
    rule: "finished trajectories deleted after agent.trajectory.retention_days; abandoned open ones ended first",
    by: "agents.trajectory-retention",
  },
  jobs: {
    kind: "rule",
    rule: "succeeded jobs deleted after jobs.retention_days; dead ones kept until an operator acts",
    by: "jobs.prune",
  },
  user_deletions: {
    kind: "rule",
    rule: "an erasure's purge completed after its retention period (the record then kept, with no personal data: the erasure's own proof — the address only as a keyed hash)",
    by: "gdpr.retention-purge",
  },
  rate_limit_events: {
    kind: "rule",
    rule: "a bucket's events older than its window deleted on every count",
    by: "the database: rate_limit_hit (migrations 039, 049)",
  },
  audit_log: {
    kind: "rule",
    rule: "rows kept (accountability: who did what); ip_address and user_agent cleared after retention.network_identifiers_days",
    by: "data.retention",
  },
  consent_records: {
    kind: "rule",
    rule: "rows kept while the account exists (the proof of consent); ip_address and user_agent cleared after retention.network_identifiers_days",
    by: "data.retention",
  },
  user_interactions: {
    kind: "rule",
    rule: "deleted after retention.user_interactions_days",
    by: "data.retention",
  },
  ai_metrics: {
    kind: "rule",
    rule: "deleted after retention.ai_metrics_days",
    by: "data.retention",
  },
  content_safety_audit: {
    kind: "rule",
    rule: "deleted after retention.content_safety_audit_days, except a decision a strike names (kept with the account's strikes)",
    by: "data.retention",
  },
  effect_ledger: {
    kind: "rule",
    rule: "resolved entries (confirmed, failed) deleted after retention.effect_ledger_days; pending and indeterminate ones kept until a person resolves them",
    by: "data.retention",
  },
  guest_usage: {
    kind: "rule",
    rule: "a guest's count deleted retention.guest_usage_days after the guest was last seen",
    by: "data.retention",
  },
  app_sessions: {
    kind: "rule",
    rule: "deleted retention.app_sessions_days after the session was last updated",
    by: "data.retention",
  },
  agent_budgets: {
    kind: "rule",
    rule: "an agent's counters for a past day deleted retention.agent_budgets_days after that day",
    by: "data.retention",
  },
  // ── Kept: the account's own data, erased with it ──────────────────────────────────────────
  users: { kind: "keep", why: `the account itself: ${ERASED}` },
  user_devices: { kind: "keep", why: `the account's remembered devices: ${ERASED}` },
  user_entitlements: { kind: "keep", why: `what the account was given: ${ERASED}` },
  user_feature_restrictions: {
    kind: "keep",
    why: `a restriction on the account (it ends by its own date): ${ERASED}`,
  },
  user_ai_context: { kind: "keep", why: `the account's AI preferences: ${ERASED}` },
  user_strikes: {
    kind: "keep",
    why: `the account's standing (strikes expire by date, moderation.expire-strikes, and stay as its history): ${ERASED}`,
  },
  review_queue: {
    kind: "keep",
    why: `a moderation case is the record of a decision on an account — its standing, its appeals: ${ERASED}`,
  },
  groups: { kind: "keep", why: `a group its owner made: ${ERASED}` },
  group_memberships: { kind: "keep", why: `membership of a group: ${ERASED}` },
  group_invites: { kind: "keep", why: `an invitation to a group: ${ERASED}` },
  document_embeddings: {
    kind: "keep",
    why: `content an app or a person stored for retrieval, deleted by its owner: ${ERASED}`,
  },
  password_policy: { kind: "keep", why: "configuration: the password rules of a scope" },
  // ── Kept: governance records — who decided what (accountability) ─────────────────────────
  proposals: {
    kind: "keep",
    why: "a held action and its decision (who asked, who approved): accountability; an erased account's mentions are replaced at erasure",
  },
  config_pending_approvals: {
    kind: "keep",
    why: "a configuration change's request and decision: accountability (expired by config.expire-approvals, never deleted)",
  },
  platform_config_history: {
    kind: "keep",
    why: "every configuration change and who made it: accountability",
  },
  tenant_lifecycle_requests: {
    kind: "keep",
    why: "a tenant's deletion request and its two operators' decision: accountability",
  },
  purge_log: {
    kind: "keep",
    why: "the record of each erasure that ran: its proof (the account id only, no personal data)",
  },
  config_dual_control_seeded: {
    kind: "keep",
    why: "which dual-control keys a migration seeded, so an operator's removal stands",
  },
  applied_migrations: { kind: "keep", why: "what was applied to this database" },
  // ── Kept: configuration and the catalog — no event data, bounded ──────────────────────────
  platform_config: { kind: "keep", why: "configuration" },
  tenant_config_overrides: { kind: "keep", why: "a tenant's configuration" },
  permissions: { kind: "keep", why: "the permission catalog" },
  roles: { kind: "keep", why: "the role catalog" },
  role_permissions: { kind: "keep", why: "the role catalog" },
  role_inheritance: { kind: "keep", why: "the role catalog" },
  entitlement_groups: { kind: "keep", why: "the entitlement catalog" },
  entitlement_permissions: { kind: "keep", why: "the entitlement catalog" },
  agent_approval_policy: {
    kind: "keep",
    why: "configuration: who approves an agent's held action",
  },
  deletion_manifest: { kind: "keep", why: "which modules erase which tables" },
  tenants: {
    kind: "keep",
    why: "the tenants (a deleted one is purged by tenancy.purge-due)",
  },
  tenant_domains: { kind: "keep", why: "a tenant's addresses, removed with it" },
  job_schedules: { kind: "keep", why: "one row per recurring job and tenant: bounded" },
  job_schedule_outcomes: {
    kind: "keep",
    why: "one row per recurring job and tenant (its last outcome, replaced each run): bounded",
  },
};

/** One rule the data.retention job applies. */
export interface RetentionRule {
  readonly table: string;
  /** The governed age, in days, and its bounds and default (migration 064's seed). */
  readonly setting: string;
  readonly defaultDays: number;
  readonly minDays: number;
  readonly maxDays: number;
  /**
   * The statement, over at most $2 rows older than the cutoff $1 (bound, never built from values);
   * row-level security keeps it to the job's tenant. Its row count is what it changed.
   */
  readonly sql: string;
}

/** The rules no other duty applies (RETENTION_REGISTER `by: "data.retention"`). */
export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    table: "audit_log",
    setting: "retention.network_identifiers_days",
    defaultDays: 90,
    minDays: 1,
    maxDays: 730,
    sql: `update audit_log set ip_address = null, user_agent = null
           where ctid in (select ctid from audit_log
                           where created_at < $1 and (ip_address is not null or user_agent is not null)
                           limit $2)`,
  },
  {
    table: "consent_records",
    setting: "retention.network_identifiers_days",
    defaultDays: 90,
    minDays: 1,
    maxDays: 730,
    sql: `update consent_records set ip_address = null, user_agent = null
           where ctid in (select ctid from consent_records
                           where granted_at < $1 and (ip_address is not null or user_agent is not null)
                           limit $2)`,
  },
  {
    table: "user_interactions",
    setting: "retention.user_interactions_days",
    defaultDays: 365,
    minDays: 7,
    maxDays: 3650,
    sql: `delete from user_interactions
           where ctid in (select ctid from user_interactions where created_at < $1 limit $2)`,
  },
  {
    table: "ai_metrics",
    setting: "retention.ai_metrics_days",
    defaultDays: 90,
    minDays: 1,
    maxDays: 730,
    sql: `delete from ai_metrics
           where ctid in (select ctid from ai_metrics where created_at < $1 limit $2)`,
  },
  {
    table: "content_safety_audit",
    setting: "retention.content_safety_audit_days",
    defaultDays: 365,
    minDays: 30,
    maxDays: 3650,
    sql: `delete from content_safety_audit
           where ctid in (select a.ctid from content_safety_audit a
                           where a.created_at < $1
                             and not exists (select 1 from user_strikes s
                                              where s.moderation_audit_id = a.id)
                           limit $2)`,
  },
  {
    table: "effect_ledger",
    setting: "retention.effect_ledger_days",
    defaultDays: 90,
    minDays: 7,
    maxDays: 730,
    sql: `delete from effect_ledger
           where ctid in (select ctid from effect_ledger
                           where status in ('confirmed', 'failed')
                             and coalesce(resolved_at, created_at) < $1
                           limit $2)`,
  },
  {
    table: "guest_usage",
    setting: "retention.guest_usage_days",
    defaultDays: 365,
    minDays: 30,
    maxDays: 3650,
    sql: `delete from guest_usage
           where ctid in (select ctid from guest_usage
                           where coalesce(last_used_at, first_used_at) < $1 limit $2)`,
  },
  {
    table: "app_sessions",
    setting: "retention.app_sessions_days",
    defaultDays: 180,
    minDays: 1,
    maxDays: 3650,
    sql: `delete from app_sessions
           where ctid in (select ctid from app_sessions
                           where coalesce(updated_at, created_at) < $1 limit $2)`,
  },
  {
    table: "agent_budgets",
    setting: "retention.agent_budgets_days",
    defaultDays: 90,
    minDays: 2,
    maxDays: 730,
    sql: `delete from agent_budgets
           where ctid in (select ctid from agent_budgets
                           where coalesce(updated_at, created_at) < $1 limit $2)`,
  },
];

/** Rows one rule changes per run at most; a full batch continues in the job's next part. */
export const RETENTION_BATCH = 5000;

/** A rule's age in whole days: its governed value, clamped to its bounds, else its default. */
export async function retentionDays(rule: RetentionRule): Promise<number> {
  try {
    const v = await getConfigNumber(rule.setting, rule.defaultDays);
    if (!Number.isFinite(v)) return rule.defaultDays;
    return Math.min(rule.maxDays, Math.max(rule.minDays, Math.floor(v)));
  } catch {
    return rule.defaultDays;
  }
}

export interface RetentionRun {
  /** Rows changed per table this run. */
  readonly changed: Readonly<Record<string, number>>;
  /** A rule changed a full batch, or the run stopped: there may be more. */
  readonly more: boolean;
}

/**
 * Apply every RETENTION_RULES rule in the current tenant: each its own transaction, at most
 * `batch` rows. Stops between rules when `signal` aborts (the rest continues in a next part).
 * A rule that fails throws: the job retries, and the rules before it stand.
 *
 * @scheduled data.retention
 */
export async function applyRetention(
  signal?: AbortSignal,
  batch = RETENTION_BATCH,
  now: () => number = Date.now
): Promise<RetentionRun> {
  const changed: Record<string, number> = {};
  let more = false;
  for (const rule of RETENTION_RULES) {
    if (signal?.aborted) return { changed, more: true };
    const days = await retentionDays(rule);
    const cutoff = new Date(now() - days * 24 * 60 * 60_000);
    const { rowCount } = await withTenantTx((tx) =>
      tx.query(rule.sql, [cutoff.toISOString(), batch])
    );
    changed[rule.table] = (changed[rule.table] ?? 0) + (rowCount ?? 0);
    if ((rowCount ?? 0) >= batch) more = true;
  }
  return { changed, more };
}
