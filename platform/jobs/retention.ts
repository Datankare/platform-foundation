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
import { TRAJECTORY_RETENTION_STEPS } from "@/platform/errors/json-limits";

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
    rule: "finished trajectories deleted after agent.trajectory.retention_days; abandoned open ones ended first; an app session's runs are deleted with their session (app_sessions' delete trigger, migration 073), and one left by a race with that delete by data.retention an hour on (deleteOrphanedSessionRuns)",
    by: "agents.trajectory-retention",
  },
  agent_trajectory_steps: {
    kind: "rule",
    rule: "a trajectory's steps (migration 076, TASK-230) are deleted with their trajectory, by the foreign key's cascade — every delete of agent_trajectories bounded by the steps it takes with it (TRAJECTORY_RETENTION_STEPS)",
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
    rule: "every event older than retention.rate_limit_events_days deleted, in every tenant, whether or not its bucket is counted again (a bucket's events past its window are also deleted when that bucket is next counted: rate_limit_hit, migrations 039, 049)",
    by: "data.retention",
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
    rule: "resolved entries (confirmed, failed) deleted after retention.effect_ledger_days; a pending one is settled indeterminate after effects.pending_timeout_minutes (platform/agents/effect-settlement.ts), and an indeterminate one waits for an operator to mark it confirmed or failed (the operator console's Jobs page), then is deleted as a resolved one",
    by: "data.retention",
  },
  guest_usage: {
    kind: "rule",
    rule: "a guest's count deleted retention.guest_usage_days after the guest was last seen",
    by: "data.retention",
  },
  auth_sessions: {
    kind: "rule",
    rule: "a sign-in session's record deleted retention.auth_sessions_days after it was last used or ended (never sooner than the longest idle lifetime, so no live session is deleted)",
    by: "data.retention",
  },
  app_sessions: {
    kind: "rule",
    rule: "deleted retention.app_sessions_days after the session was last updated — its agent runs (agent_trajectories, subject_kind 'session') with it, by the table's delete trigger (migration 073), each batch bounded by the runs' steps too (TASK-230)",
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
  provider_usage: {
    kind: "keep",
    why: "one row per prepaid provider (a running count, TASK-212): bounded, and no person's data",
  },
};

/**
 * Every store outside the database's tables, and how long it keeps what it holds (TASK-215, the
 * S4 sweep by store: B-13, B-14). The tables are RETENTION_REGISTER's; these are the rest — the
 * platform's own stores, the browser, and the services a request's data is sent to (each keeps it
 * under the owner's agreement with it, not the platform's). Held to the code by
 * __tests__/retention-stores.test.ts: each cache backend bounds every entry, and every store the
 * code can select or write (RETENTION_STORE_SOURCES) names its entry here.
 */
export const RETENTION_STORES: Readonly<Record<string, string>> = {
  "shared cache (Valkey or Redis, platform/cache)":
    "every entry expires: its TTL, or the store's default (CACHE_DEFAULT_TTL, an hour), never more than seven days — a missing or zero TTL was kept for good (platform/cache/ttl.ts)",
  "AI answers (platform/cache/ai-cache.ts)":
    "entries in the shared cache under a hash of the request: an hour by default (a use case's own TTL), never more than seven days",
  "in-memory cache (one instance)":
    "the same bounds as the shared cache, and at most its entry limit; gone when the instance stops",
  "permission and configuration caches (one instance)":
    "each entry until its TTL (or an invalidation stamp), and gone when the instance stops",
  "rate limiter (Valkey, Redis or memory)":
    "a bucket's key expires with its window (EXPIRE window seconds; the memory limiter sweeps expired windows); the database limiter's rows are rate_limit_events'",
  "Realtime channels (Supabase Realtime)":
    "nothing stored: messages are relayed, not kept",
  "the database's tables":
    "each table's rule or reason in RETENTION_REGISTER (an app's in its manifest's retention); a memory store, for local and CI runs only, keeps nothing past its instance",
  "the browser":
    "httpOnly cookies no script can read: the session's id (__Host-pf_session; its tokens are sealed on the server, auth_sessions — ADR-057) until the session's end or sign-out, an SSO attempt's state for ten minutes, and a restricted account's marker for thirty days. The forgery-check token is held in the page's memory only. Nothing is kept in localStorage, sessionStorage or a script-readable cookie: what a page before ADR-057 kept there (pf_access_token, pf_refresh_token, pf_user) is deleted on its first load, and the legacy cookies are cleared. Playform's translate session id is held in the page's memory only",
  "identity provider (Amazon Cognito)":
    "an account's identity while the account exists; deleted from the pool when the account is erased (user_deletions.external_erasures, TASK-193)",
  "AI model provider (Anthropic)":
    "what a request sends (a prompt, a text to screen) is the provider's to keep under the owner's agreement with it; the platform keeps what its tables record (RETENTION_REGISTER) and the AI-answer cache above",
  "embeddings provider (OpenAI)":
    "a document's text sent to be embedded is the provider's to keep under the owner's agreement with it; the vectors are document_embeddings'",
  "translation and speech providers (Google Cloud)":
    "a text to translate or speak, or a recording to transcribe, is sent per request and is the provider's to keep under the owner's agreement with it; the platform keeps none of it outside its tables",
  "song identification (ACRCloud)":
    "a recording's sample is sent per request and is the provider's to keep under the owner's agreement with it; no recording is stored (an app's identify route holds it for the request only); the billed requests are counted (provider_usage)",
  "audio conversion service (AUDIO_CONVERTER_URL)":
    "a recording is sent per request to the deployment's conversion service, which answers with the converted audio; what that service keeps is set where it is deployed",
  "logs and error reports (the deployment's log drain and Sentry)":
    "kept by the provider for its configured period (the owner sets it: docs/APP_ENV_REFERENCE.md); what reaches them is redacted (lib/logger.ts, lib/log-fields.ts)",
};

/**
 * Where each store comes from in the code, and its entry in RETENTION_STORES (TASK-215, B-13,
 * B-14): every setting that selects a provider or a store (a `*_PROVIDER`, `*_STORE`, `*_LEDGER`,
 * `*_REPORTER` or `*_CONVERTER` setting, or a module slot's `envVar`), and every file that writes
 * the browser's storage or sets a cookie. __tests__/retention-stores.test.ts finds them in the code and fails on one
 * named here by none — a new store has no retention until it is stated. An app names its own in
 * its manifest's `retentionStores` (platform/modules/app-manifest.json).
 */
export const RETENTION_STORE_SOURCES: Readonly<Record<string, string>> = {
  AUTH_PROVIDER: "identity provider (Amazon Cognito)",
  NEXT_PUBLIC_AUTH_PROVIDER: "identity provider (Amazon Cognito)",
  CACHE_PROVIDER: "shared cache (Valkey or Redis, platform/cache)",
  AI_PROVIDER: "AI model provider (Anthropic)",
  ERROR_REPORTER: "logs and error reports (the deployment's log drain and Sentry)",
  REALTIME_PROVIDER: "Realtime channels (Supabase Realtime)",
  EMBEDDING_PROVIDER: "embeddings provider (OpenAI)",
  TRANSLATION_PROVIDER: "translation and speech providers (Google Cloud)",
  TTS_PROVIDER: "translation and speech providers (Google Cloud)",
  STT_PROVIDER: "translation and speech providers (Google Cloud)",
  SONG_ID_PROVIDER: "song identification (ACRCloud)",
  AUDIO_CONVERTER: "audio conversion service (AUDIO_CONVERTER_URL)",
  RATE_LIMIT_STORE: "rate limiter (Valkey, Redis or memory)",
  MODERATION_STORE: "the database's tables",
  STRIKE_STORE: "the database's tables",
  REVIEW_QUEUE_STORE: "the database's tables",
  APP_STATE_STORE: "the database's tables",
  TRAJECTORY_STORE: "the database's tables",
  BUDGET_STORE: "the database's tables",
  PROPOSAL_STORE: "the database's tables",
  EFFECT_LEDGER: "the database's tables",
  APPROVAL_POLICY_STORE: "the database's tables",
  GUEST_USAGE_STORE: "the database's tables",
  JOB_STORE: "the database's tables",
  TENANT_DIRECTORY_STORE: "the database's tables",
  SOCIAL_STORE: "the database's tables",
  // What a page keeps in the browser: the cookies the server sets, and the one file that touches
  // the page's storage (only to delete what a page before ADR-057 kept there).
  "platform/auth/legacy-session-cleanup.ts": "the browser",
  "platform/auth/session.ts": "the browser",
  "platform/auth/auth-response.ts": "the browser",
  "platform/auth/restricted-marker.ts": "the browser",
  "platform/auth/mfa-routes.ts": "the browser",
  "app/api/auth/sso/[provider]/route.ts": "the browser",
  "app/api/auth/sso/callback/route.ts": "the browser",
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
   * row-level security keeps it to the job's tenant. Its row count is what it changed — or, for a
   * rule `stepBounded`, the one row it returns.
   */
  readonly sql: string;
  /**
   * The rule's delete takes agent runs with it (their steps by cascade, TASK-230): its statement
   * also takes $3, the most steps it may delete (TRAJECTORY_RETENTION_STEPS; its first row always
   * goes), and returns one row — `changed`, and `more` when a due row was left by either bound
   * (confirmation CB3-4).
   */
  readonly stepBounded?: true;
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
    table: "auth_sessions",
    setting: "retention.auth_sessions_days",
    defaultDays: 45,
    // Above the longest idle lifetime (30 days, session-lifetimes.ts): a session not used for
    // this long has ended under every allowed setting.
    minDays: 31,
    maxDays: 400,
    sql: `delete from auth_sessions
           where ctid in (select ctid from auth_sessions
                           where greatest(last_seen_at, coalesce(revoked_at, last_seen_at)) < $1
                           limit $2)`,
  },
  {
    table: "app_sessions",
    setting: "retention.app_sessions_days",
    defaultDays: 180,
    minDays: 1,
    maxDays: 3650,
    // A session's runs go with it (073's delete trigger) and their steps with them: bounded by
    // the steps too (TASK-230) — the sessions oldest first while their runs' steps add up to $3.
    stepBounded: true,
    sql: `with cand as (
            select s.ctid as k, s.id, coalesce(s.updated_at, s.created_at) as at,
                   (select coalesce(sum(t.step_count), 0) from agent_trajectories t
                     where t.tenant_id = s.tenant_id and t.subject_kind = 'session' and t.subject_id = s.id) as n
              from app_sessions s
             where coalesce(s.updated_at, s.created_at) < $1
             order by at, id
             limit $2::int + 1
          ),
          ranked as (
            select k, row_number() over w as rn, sum(n) over w as run
              from cand
            window w as (order by at, id rows between unbounded preceding and current row)
          ),
          pick as (select k from ranked where rn <= $2::int and (rn = 1 or run <= $3::bigint)),
          gone as (delete from app_sessions where ctid in (select k from pick) returning 1)
          select (select count(*) from gone)::int as changed,
                 (select count(*) from cand) > (select count(*) from pick) as more`,
  },
  {
    // TASK-215: a bucket's old events were deleted only when that bucket was counted again (and by
    // a 1-in-100 sweep of the current tenant on some later count), so a one-time visitor's address
    // could stay indefinitely in a quiet tenant. Now every tenant's, on a schedule.
    table: "rate_limit_events",
    setting: "retention.rate_limit_events_days",
    defaultDays: 1,
    minDays: 1,
    maxDays: 30,
    sql: `delete from rate_limit_events
           where ctid in (select ctid from rate_limit_events where at < $1 limit $2)`,
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

/** How long a session's run may exist without its session before it is an orphan (a race's). */
export const ORPHAN_SESSION_RUN_MINUTES = 60;

/**
 * In the current tenant: delete the runs of app sessions that no longer exist, opened over an hour
 * ago (TASK-215, audit B-5). A session's runs go with it by app_sessions' delete trigger (073); a
 * run opened by a request that still held a session while another deleted it commits after the
 * trigger ran, and nothing else ends a session's run (the trajectory reaper leaves them to the
 * session). A run is opened after its session is stored, so one an hour old with no session is such
 * an orphan. At most `batch` runs, oldest first, and while their steps (deleted with them by
 * cascade) add up to at most `maxSteps` (the first always: TASK-230); `more` when an orphan was
 * left by either bound (confirmation CB3-4).
 *
 * @scheduled data.retention
 */
export async function deleteOrphanedSessionRuns(
  batch = RETENTION_BATCH,
  maxSteps = TRAJECTORY_RETENTION_STEPS
): Promise<{ readonly deleted: number; readonly more: boolean }> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ deleted: number; more: boolean }>(
      `with cand as (
         select t.id, t.created_at, t.step_count from agent_trajectories t
          where t.subject_kind = 'session'
            and t.created_at < now() - make_interval(mins => $2::int)
            and not exists (select 1 from app_sessions s
                             where s.id = t.subject_id and s.tenant_id = t.tenant_id)
          order by t.created_at, t.id
          limit $1::int + 1
       ),
       ranked as (
         select id, row_number() over w as rn, sum(step_count) over w as run
           from cand
         window w as (order by created_at, id rows between unbounded preceding and current row)
       ),
       pick as (select id from ranked where rn <= $1::int and (rn = 1 or run <= $3::bigint)),
       gone as (delete from agent_trajectories where id in (select id from pick) returning 1)
       select (select count(*) from gone)::int as deleted,
              (select count(*) from cand) > (select count(*) from pick) as more`,
      [batch, ORPHAN_SESSION_RUN_MINUTES, maxSteps]
    )
  );
  return { deleted: Number(rows[0]?.deleted ?? 0), more: rows[0]?.more === true };
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
    if (rule.stepBounded) {
      const { rows } = await withTenantTx((tx) =>
        tx.query<{ changed: number; more: boolean }>(rule.sql, [
          cutoff.toISOString(),
          batch,
          TRAJECTORY_RETENTION_STEPS,
        ])
      );
      changed[rule.table] = (changed[rule.table] ?? 0) + Number(rows[0]?.changed ?? 0);
      if (rows[0]?.more === true) more = true;
      continue;
    }
    const { rowCount } = await withTenantTx((tx) =>
      tx.query(rule.sql, [cutoff.toISOString(), batch])
    );
    changed[rule.table] = (changed[rule.table] ?? 0) + (rowCount ?? 0);
    if ((rowCount ?? 0) >= batch) more = true;
  }
  return { changed, more };
}
