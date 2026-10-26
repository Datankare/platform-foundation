/**
 * platform/auth/user-data.ts — Every table that holds a user's data, and what erasure and export
 * do with it (GDPR Articles 15 and 17; audit X-15, E-7, E-8, RR-23)
 *
 * One register, read by both rights:
 *
 *   - erasure (eraseUserData, run by the hard purge — the retention job and the admin purge)
 *     deletes the user's rows, or anonymises the ones kept for a stated reason, in one
 *     transaction in the request's tenant: all or nothing;
 *   - export (exportUserTables, read by data-export) returns every row the user can be given.
 *
 * Before: the platform registered no deletion or export module, so a purge removed the user row
 * and whatever its foreign keys cascaded to, and an export returned four tables. Moderation
 * history, AI interactions and context, trajectories, proposals, review items, rate-limit
 * buckets, metrics and embeddings stayed (E-8), and the deletion_manifest seed named tables that
 * no longer exist (E-7).
 *
 * Every table of the schema is classified: here (USER_DATA_TABLES), or in NO_USER_DATA with the
 * reason it holds none. `__tests__/db/user-data-coverage.db.test.ts` fails when a table is
 * neither — a new table cannot hold user data the erasure does not know about — and proves on
 * Postgres that, after erasure, no row of any listed table still names the user.
 *
 * Columns too (review 7 M4, review 8 M3): every column of every table (plain or partitioned)
 * of a kind that can hold an identity or a text — uuid, text and the other string types, arrays
 * of them, json, jsonb — is claimed by a register entry (`columns`) or listed in
 * NO_USER_DATA_COLUMNS with its reason. A claim is a promise the coverage test checks: it writes
 * the user's id (and, where an address can stand for the account, their address) into every
 * claimed column of another row, erases the user, and proves no row of the table still holds
 * it — so an entry claims only the columns its erasure clears in every row, not only in the
 * user's own (review 8 M3: audit_log.details and review_queue's moderation record were claimed
 * and never cleared). An id is matched in any case; an address is replaced by the id at the soft
 * delete only where it is a whole JSON string — a value or an object key (ADDRESS_REPLACEMENTS,
 * review 8 H-C, review 9 L7). Free text that quotes an address (a note, a message) is out of
 * scope for both the erasure and the export: it is another person's writing, and finding an
 * address in prose would be a guess (docs/MIGRATION_v5_to_v6.md, "What erasure does not reach").
 *
 * What an export gives (review 7 M1–M3): the user's own rows, all of them — every section is read
 * in pages over one snapshot, never cut off at a row limit — and nothing of another person's:
 * a shared session's state is the participants' together and is not exported (the user's own
 * part of it, their steps, is); an audit row about the user written by someone else says what was
 * done and when, never who did it, from where, or their notes (auditRowsForExport).
 *
 * An app adds its own tables through registerDeletionModule / registerExportModule.
 *
 * @module platform/auth
 */

import type { Tx } from "@/platform/data";

/**
 * One table's part of a user's data. Every statement is fixed SQL with the user id as `$1` (and,
 * on export, the page size as `$2` and the last row's key — its ctid, a text tid — as `$3`),
 * never text built from input; the id is checked to be a UUID before any of them runs. Being
 * literals, they are planned against the schema by `sql-schema-parity` like every other
 * statement the code sends.
 */
export interface UserDataTable {
  /** Name of the register entry, unique; also the export's key. */
  readonly name: string;
  readonly table: string;
  /** delete: the rows are the user's. anonymise: kept for `reason`, what names the user cleared. */
  readonly action: "delete" | "anonymise";
  readonly reason?: string;
  /**
   * The columns (`table.column`) whose references to the user this entry erases — the coverage
   * test requires every column that can name a user to be claimed here or in
   * NO_USER_DATA_COLUMNS.
   */
  readonly columns: readonly string[];
  /** How many of the table's rows name the user (`n`). */
  readonly count: string;
  /** The erasure: a delete, or an update that leaves no row naming the user. */
  readonly erase: string;
  /**
   * One page of the user's rows on export (`r`, one JSON object each, and `k`, the row's key),
   * ordered by key and after `$3`; undefined: see `exportReason`.
   */
  readonly exportSql?: string;
  readonly exportReason?: string;
}

/**
 * The register, in erasure order: rows that refer to others first, the user row last. A table
 * reached only through a cascade is listed too, so its rows are counted and the coverage check
 * sees it.
 */
export const USER_DATA_TABLES: readonly UserDataTable[] = [
  // ── Moderation and safety ───────────────────────────────────────────────────────────────
  {
    name: "reviewItems",
    table: "review_queue",
    action: "delete",
    columns: ["review_queue.target_user_id"],
    count: "select count(*)::int as n from review_queue where target_user_id = $1::uuid",
    erase: "delete from review_queue where target_user_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, source, status, decision, modified_action, appeal_reason, created_at, resolved_at, ctid as _k from review_queue where (target_user_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "reviewsDecided",
    table: "review_queue",
    action: "anonymise",
    columns: ["review_queue.claimed_by", "review_queue.resolved_by"],
    reason:
      "a moderation decision about another account stands; only the reviewer is removed",
    count:
      "select count(*)::int as n from review_queue where claimed_by = $1 or resolved_by = $1",
    erase:
      "update review_queue set claimed_by = case when claimed_by = $1 then null else claimed_by end, resolved_by = case when resolved_by = $1 then null else resolved_by end where claimed_by = $1 or resolved_by = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, status, decision, resolved_at, ctid as _k from review_queue where (claimed_by = $1 or resolved_by = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  // Review 8 M3: another account's case can name the user in its moderation record or its
  // explanation (a participant, a reporter). Before, these columns were claimed by reviewItems,
  // whose erasure reached only the user's own cases.
  {
    name: "reviewMentions",
    table: "review_queue",
    action: "anonymise",
    columns: ["review_queue.moderation_result", "review_queue.explanation_chain"],
    reason:
      "another account's case stands; every mention of the user's id in its record is replaced",
    count:
      "select count(*)::int as n from review_queue where moderation_result::text ~* $1::text or coalesce(explanation_chain::text, '') ~* $1::text",
    erase:
      "update review_queue set moderation_result = regexp_replace(moderation_result::text, $1::text, 'erased', 'gi')::jsonb, explanation_chain = regexp_replace(explanation_chain::text, $1::text, 'erased', 'gi')::jsonb where moderation_result::text ~* $1::text or coalesce(explanation_chain::text, '') ~* $1::text",
    exportReason: "another account's case; the user's own cases are reviewItems",
  },
  {
    name: "strikes",
    table: "user_strikes",
    action: "delete",
    columns: ["user_strikes.user_id"],
    count: "select count(*)::int as n from user_strikes where user_id = $1::uuid",
    erase: "delete from user_strikes where user_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, category, severity, reason, expires_at, expired, created_at, ctid as _k from user_strikes where (user_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "featureRestrictions",
    table: "user_feature_restrictions",
    action: "delete",
    columns: ["user_feature_restrictions.user_id"],
    count:
      "select count(*)::int as n from user_feature_restrictions where user_id = $1::uuid",
    erase: "delete from user_feature_restrictions where user_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select feature, reason, created_at, ctid as _k from user_feature_restrictions where (user_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "restrictionsSet",
    table: "user_feature_restrictions",
    action: "anonymise",
    columns: ["user_feature_restrictions.created_by"],
    reason: "a restriction on another account stands; only who set it is removed",
    count:
      "select count(*)::int as n from user_feature_restrictions where created_by = $1",
    erase:
      "update user_feature_restrictions set created_by = 'erased' where created_by = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select feature, created_at, ctid as _k from user_feature_restrictions where (created_by = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "moderationDecisions",
    table: "content_safety_audit",
    action: "anonymise",
    columns: ["content_safety_audit.user_id"],
    reason:
      "the decision record keeps no content (a hash of it), and is kept unattributed for the safety statistics",
    count: "select count(*)::int as n from content_safety_audit where user_id = $1",
    erase: "update content_safety_audit set user_id = null where user_id = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, direction, content_type, action_taken, categories_flagged, severity, created_at, ctid as _k from content_safety_audit where (user_id = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  // ── AI and agents ───────────────────────────────────────────────────────────────────────
  {
    name: "aiInteractions",
    table: "user_interactions",
    action: "delete",
    columns: ["user_interactions.user_id"],
    count: "select count(*)::int as n from user_interactions where user_id = $1",
    erase: "delete from user_interactions where user_id = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, feature, input, output, rating, created_at, ctid as _k from user_interactions where (user_id = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "aiContext",
    table: "user_ai_context",
    action: "delete",
    columns: ["user_ai_context.user_id"],
    count: "select count(*)::int as n from user_ai_context where user_id = $1",
    erase: "delete from user_ai_context where user_id = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select preferences, patterns, updated_at, ctid as _k from user_ai_context where (user_id = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  // Another account's remembered context can name the user (who they play with) (M3).
  {
    name: "aiContextMentions",
    table: "user_ai_context",
    action: "anonymise",
    columns: ["user_ai_context.preferences", "user_ai_context.patterns"],
    reason:
      "another account's context stays theirs; every mention of the user's id in it is replaced",
    count:
      "select count(*)::int as n from user_ai_context where preferences::text ~* $1::text or array_to_string(patterns, ' ') ~* $1::text",
    erase:
      "update user_ai_context set preferences = regexp_replace(preferences::text, $1::text, 'erased', 'gi')::jsonb, patterns = array(select regexp_replace(x.p, $1::text, 'erased', 'gi') from unnest(patterns) with ordinality as x(p, n) order by x.n) where preferences::text ~* $1::text or array_to_string(patterns, ' ') ~* $1::text",
    exportReason: "another account's context; the user's own is aiContext",
  },
  {
    name: "proposals",
    table: "proposals",
    action: "delete",
    columns: ["proposals.actor_id"],
    count:
      "select count(*)::int as n from proposals where actor_id = $1 or actor_identity->>'onBehalfOf' = $1",
    erase:
      "delete from proposals where actor_id = $1 or actor_identity->>'onBehalfOf' = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, label, status, payload, created_at, decided_at, ctid as _k from proposals where (actor_id = $1 or actor_identity->>'onBehalfOf' = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "proposalsDecided",
    table: "proposals",
    action: "anonymise",
    columns: ["proposals.decided_by"],
    reason:
      "a decision on another account's held action stands; only the approver is removed",
    count: "select count(*)::int as n from proposals where decided_by = $1",
    erase: "update proposals set decided_by = null where decided_by = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, label, status, decided_at, ctid as _k from proposals where (decided_by = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  // A held action another account proposed about the user (a role change naming them, review 7
  // M4): one still waiting (proposed, or approved and not yet run) can no longer be carried out
  // on an erased account and goes; one decided stands, with the user's id replaced. An email
  // naming them is replaced by their id at the soft delete (softDeleteUser), so both are found.
  // About the user means the id is a value in the document (review 8 H-C: never a near miss).
  {
    name: "proposalsHeldAbout",
    table: "proposals",
    action: "delete",
    reason: "a held action about an erased account can no longer be carried out",
    columns: [],
    count:
      "select count(*)::int as n from proposals where status in ('proposed', 'approved') and (jsonb_path_exists(payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) or jsonb_path_exists(effects, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)))",
    erase:
      "delete from proposals where status in ('proposed', 'approved') and (jsonb_path_exists(payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) or jsonb_path_exists(effects, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)))",
    exportReason:
      "another account's proposed action about the user; what it did, once carried out, is in the user's profile and audit trail",
  },
  {
    name: "proposalsAbout",
    table: "proposals",
    action: "anonymise",
    reason:
      "a decided action that mentions the user stands as the record of the decision; every mention of the user's id in it is replaced",
    columns: [
      "proposals.payload",
      "proposals.effects",
      "proposals.decision_note",
      "proposals.last_run_error",
      "proposals.actor_identity",
    ],
    count:
      "select count(*)::int as n from proposals where payload::text ~* $1::text or effects::text ~* $1::text or coalesce(decision_note, '') ~* $1::text or coalesce(last_run_error, '') ~* $1::text or coalesce(actor_identity::text, '') ~* $1::text",
    erase:
      "update proposals set payload = regexp_replace(payload::text, $1::text, 'erased', 'gi')::jsonb, effects = regexp_replace(effects::text, $1::text, 'erased', 'gi')::jsonb, decision_note = regexp_replace(decision_note, $1::text, 'erased', 'gi'), last_run_error = regexp_replace(last_run_error, $1::text, 'erased', 'gi'), actor_identity = regexp_replace(actor_identity::text, $1::text, 'erased', 'gi')::jsonb where payload::text ~* $1::text or effects::text ~* $1::text or coalesce(decision_note, '') ~* $1::text or coalesce(last_run_error, '') ~* $1::text or coalesce(actor_identity::text, '') ~* $1::text",
    exportReason:
      "another account's decided action about the user; its effect is in the user's profile and audit trail",
  },
  {
    name: "trajectories",
    table: "agent_trajectories",
    action: "delete",
    columns: [],
    count:
      "select count(*)::int as n from agent_trajectories where scope_type = 'user' and scope_id = $1",
    erase: "delete from agent_trajectories where scope_type = 'user' and scope_id = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, segment, previous_trajectory_id, trigger, status, steps, started_at, completed_at, ctid as _k from agent_trajectories where (scope_type = 'user' and scope_id = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  // An app session's trajectory is opened with scope 'user' and no scope id
  // (platform/app-framework/session.ts), so it is found through its session (review 7 M4). The
  // history of a session that was the user's alone goes with the session — before it, while the
  // session still says whose it is.
  {
    name: "sessionTrajectories",
    table: "agent_trajectories",
    action: "delete",
    columns: [],
    count:
      "select count(*)::int as n from agent_trajectories where subject_kind = 'session' and subject_id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1)",
    erase:
      "delete from agent_trajectories where subject_kind = 'session' and subject_id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1)",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, subject_id as session_id, segment, previous_trajectory_id, trigger, status, steps, started_at, completed_at, ctid as _k from agent_trajectories where (subject_kind = 'session' and subject_id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1)) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  // Any other run that names the user — a shared session's, an agent's run about them, any
  // scope. The run stands for the others in it; every mention of the user's id (in its steps, or
  // as its scope) becomes "erased" (a UUID is hex and hyphens, so the replacement cannot touch the
  // JSON around it). On export, only the steps the user took themselves (their actor), in runs
  // they took part in (review 8 L2: every step that merely mentioned their id was exported, so
  // anyone could fill another user's export to the size cap by writing runs naming them; another
  // person's step about the user is that person's record, not the user's data).
  {
    name: "trajectorySteps",
    table: "agent_trajectories",
    action: "anonymise",
    reason:
      "a run others took part in stands for them; the user's id in its steps is replaced",
    columns: ["agent_trajectories.steps", "agent_trajectories.scope_id"],
    count:
      "select count(*)::int as n from agent_trajectories where (steps::text ~* $1::text or scope_id = $1::text) and not coalesce(scope_type = 'user' and scope_id = $1, false) and not (subject_kind = 'session' and subject_id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1))",
    erase:
      "update agent_trajectories set steps = regexp_replace(steps::text, $1::text, 'erased', 'gi')::jsonb, scope_id = case when scope_id = $1::text then 'erased' else scope_id end where (steps::text ~* $1::text or scope_id = $1::text) and not coalesce(scope_type = 'user' and scope_id = $1, false) and not (subject_kind = 'session' and subject_id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1))",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, segment, previous_trajectory_id, trigger, started_at, (select coalesce(jsonb_agg(s.step order by s.n), '[]'::jsonb) from jsonb_array_elements(a.steps) with ordinality as s(step, n) where s.step->'actor'->>'actorId' = $1::text) as steps, a.ctid as _k from agent_trajectories a where (a.steps @> jsonb_build_array(jsonb_build_object('actor', jsonb_build_object('actorId', $1::text))) and not coalesce(scope_type = 'user' and scope_id = $1, false) and not (subject_kind = 'session' and subject_id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1))) and a.ctid > $3::tid order by a.ctid limit $2::int) t",
  },
  {
    name: "agentBudgets",
    table: "agent_budgets",
    action: "delete",
    columns: ["agent_budgets.scope_id"],
    count: "select count(*)::int as n from agent_budgets where scope_id = $1",
    erase: "delete from agent_budgets where scope_id = $1",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select agent_id, period, used_usd, used_steps, updated_at, ctid as _k from agent_budgets where (scope_id = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "aiMetrics",
    table: "ai_metrics",
    action: "delete",
    columns: ["ai_metrics.tags"],
    count: "select count(*)::int as n from ai_metrics where tags::text ~* $1::text",
    erase: "delete from ai_metrics where tags::text ~* $1::text",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select name, \"timestamp\", \"values\", ctid as _k from ai_metrics where (tags->>'userId' = $1 or tags->>'actorId' = $1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "documents",
    table: "document_embeddings",
    action: "delete",
    columns: ["document_embeddings.scope_key"],
    count:
      "select count(*)::int as n from document_embeddings where scope_key ~* $1::text",
    erase: "delete from document_embeddings where scope_key ~* $1::text",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select document_id, chunk_index, content, created_at, ctid as _k from document_embeddings where (scope_key ~* $1::text) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "rateLimitBuckets",
    table: "rate_limit_events",
    action: "delete",
    columns: ["rate_limit_events.bucket"],
    count: "select count(*)::int as n from rate_limit_events where bucket ~* $1::text",
    erase: "delete from rate_limit_events where bucket ~* $1::text",
    exportReason:
      "counters of the last few minutes' requests; nothing about their content",
  },
  // ── App sessions (ADR-049: a session's participants are named in its meta) ──────────────
  {
    name: "appSessions",
    table: "app_sessions",
    action: "delete",
    columns: [],
    count:
      "select count(*)::int as n from app_sessions where id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1)",
    erase:
      "delete from app_sessions where id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1)",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, state, created_at, updated_at, ctid as _k from app_sessions where (id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1)) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "sharedAppSessions",
    table: "app_sessions",
    action: "anonymise",
    columns: [],
    reason:
      "a session other participants share stays theirs; the user is removed from it, and their id in its state is replaced",
    count:
      "select count(*)::int as n from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') > 1",
    erase:
      "update app_sessions set meta = jsonb_set(meta, '{participants}', ( select coalesce(jsonb_agg(p), '[]'::jsonb) from jsonb_array_elements(meta->'participants') p where p->>'actorId' <> $1::text)), state = replace(state::text, $1::text, 'erased')::jsonb where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') > 1",
    // The state is the participants' together, not the user's (review 7 M3: it was exported
    // whole, with the others' part). The user's own part — their steps — is in trajectorySteps.
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, created_at, updated_at, (select p from jsonb_array_elements(meta->'participants') p where p->>'actorId' = $1::text limit 1) as participant, ctid as _k from app_sessions where (meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') > 1) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  // Any other session that still names the user — in its meta or its state, not as a
  // participant (M3).
  {
    name: "sessionMentions",
    table: "app_sessions",
    action: "anonymise",
    columns: ["app_sessions.meta", "app_sessions.state"],
    reason:
      "a session that is others' stays theirs; every mention of the user's id in it is replaced",
    count:
      "select count(*)::int as n from app_sessions where meta::text ~* $1::text or state::text ~* $1::text",
    erase:
      "update app_sessions set meta = regexp_replace(meta::text, $1::text, 'erased', 'gi')::jsonb, state = regexp_replace(state::text, $1::text, 'erased', 'gi')::jsonb where meta::text ~* $1::text or state::text ~* $1::text",
    exportReason:
      "others' sessions; the user's own part is in their steps (trajectorySteps)",
  },
  // ── Social (latent: no route reaches it yet, X-25) ──────────────────────────────────────
  {
    name: "groupInvites",
    table: "group_invites",
    action: "delete",
    columns: ["group_invites.inviter_id", "group_invites.invitee_id"],
    count:
      "select count(*)::int as n from group_invites where inviter_id = $1::uuid or invitee_id = $1::uuid",
    erase:
      "delete from group_invites where inviter_id = $1::uuid or invitee_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, group_id, status, created_at, resolved_at, ctid as _k from group_invites where (inviter_id = $1::uuid or invitee_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "groupMemberships",
    table: "group_memberships",
    action: "delete",
    columns: ["group_memberships.user_id"],
    count: "select count(*)::int as n from group_memberships where user_id = $1::uuid",
    erase: "delete from group_memberships where user_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select group_id, role, joined_at, left_at, ctid as _k from group_memberships where (user_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "groupsOwned",
    table: "groups",
    action: "delete",
    columns: ["groups.owner_id"],
    count: "select count(*)::int as n from groups where owner_id = $1::uuid",
    erase: "delete from groups where owner_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select id, name, description, created_at, ctid as _k from groups where (owner_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  // ── Account ─────────────────────────────────────────────────────────────────────────────
  {
    name: "consents",
    table: "consent_records",
    action: "delete",
    columns: ["consent_records.user_id"],
    count: "select count(*)::int as n from consent_records where user_id = $1::uuid",
    erase: "delete from consent_records where user_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select consent_type, consent_version, granted, granted_at, revoked_at, ip_address, user_agent, ctid as _k from consent_records where (user_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "devices",
    table: "user_devices",
    action: "delete",
    columns: ["user_devices.user_id"],
    count: "select count(*)::int as n from user_devices where user_id = $1::uuid",
    erase: "delete from user_devices where user_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select device_id, device_name, is_trusted, last_used_at, created_at, ctid as _k from user_devices where (user_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "entitlements",
    table: "user_entitlements",
    action: "delete",
    columns: ["user_entitlements.user_id"],
    count: "select count(*)::int as n from user_entitlements where user_id = $1::uuid",
    erase: "delete from user_entitlements where user_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select entitlement_group_id, granted_at, expires_at, revoked_at, ctid as _k from user_entitlements where (user_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "entitlementsGranted",
    table: "user_entitlements",
    action: "anonymise",
    columns: ["user_entitlements.granted_by", "user_entitlements.revoked_by"],
    reason:
      "another account's entitlement stands; only who granted or revoked it is removed",
    count:
      "select count(*)::int as n from user_entitlements where granted_by = $1::uuid or revoked_by = $1::uuid",
    erase:
      "update user_entitlements set granted_by = case when granted_by = $1::uuid then null else granted_by end, revoked_by = case when revoked_by = $1::uuid then null else revoked_by end where granted_by = $1::uuid or revoked_by = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select entitlement_group_id, granted_at, revoked_at, ctid as _k from user_entitlements where (granted_by = $1::uuid or revoked_by = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "passwordPolicy",
    table: "password_policy",
    action: "delete",
    columns: ["password_policy.user_id"],
    count: "select count(*)::int as n from password_policy where user_id = $1::uuid",
    erase: "delete from password_policy where user_id = $1::uuid",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select rotation_days, min_length, require_uppercase, require_lowercase, require_number, require_special, ctid as _k from password_policy where (user_id = $1::uuid) and ctid > $3::tid order by ctid limit $2::int) t",
  },
  {
    name: "auditLog",
    table: "audit_log",
    action: "anonymise",
    columns: [],
    reason:
      "the security record of what was done is kept (Article 17(3)(e)); it keeps the account's id, which no longer names anyone, and loses the network address and browser",
    count:
      "select count(*)::int as n from audit_log where actor_id = $1::uuid or target_id = $1::uuid",
    erase:
      "update audit_log set ip_address = null, user_agent = null where actor_id = $1::uuid or target_id = $1::uuid",
    exportReason: "exported as auditLog by data-export (auditRowsForUser)",
  },
  // Review 8 M3: audit_log.details was claimed by auditLog, whose erasure never touched it — an
  // act by someone else about the user (or an address the soft delete turned into the id) kept
  // the id in its details.
  {
    name: "auditMentions",
    table: "audit_log",
    action: "anonymise",
    columns: ["audit_log.details"],
    reason:
      "the record of an act stands; every mention of the user's id in its details is replaced",
    count: "select count(*)::int as n from audit_log where details::text ~* $1::text",
    erase:
      "update audit_log set details = regexp_replace(details::text, $1::text, 'erased', 'gi')::jsonb where details::text ~* $1::text",
    exportReason: "exported as auditLog by data-export (auditRowsForUser)",
  },
  // A moderator's or administrator's id on another account's standing (review 7 M4: it outlived
  // their erasure). The standing stands; who changed it is removed — the act is in the audit log.
  {
    name: "statusChanges",
    table: "users",
    action: "anonymise",
    reason: "another account's standing stands; only who changed it is removed",
    columns: ["users.status_changed_by"],
    count:
      "select count(*)::int as n from users where status_changed_by = $1::text and id <> $1::uuid",
    erase:
      "update users set status_changed_by = null where status_changed_by = $1::text and id <> $1::uuid",
    exportReason:
      "another account's standing; the user's act of changing it is in their audit trail (auditLog)",
  },
  {
    name: "profile",
    table: "users",
    action: "delete",
    columns: [],
    count: "select count(*)::int as n from users where id = $1::uuid",
    erase: "delete from users where id = $1::uuid",
    exportReason: "exported as profile by data-export",
  },
];

/**
 * Tables that hold no user's data, or hold it only as the record of an administrative act or of
 * the erasure itself, with the reason. Every table is in one register or the other.
 */
export const NO_USER_DATA: Readonly<Record<string, string>> = {
  agent_approval_policy:
    "the approval policy; decided_by is the administrative act's author",
  applied_migrations: "schema history",
  config_dual_control_seeded:
    "which dual-control keys a migration seeded (review 13 L4); no per-user rows",
  config_pending_approvals:
    "configuration changes; requested_by and reviewed_by record who made an administrative change",
  deletion_manifest: "the registry of deletion modules (no per-user rows)",
  effect_ledger: "receipts of external calls, keyed by operation",
  entitlement_groups:
    "the entitlement catalog; created_by is the administrative act's author",
  entitlement_permissions: "the entitlement catalog",
  guest_usage: "guest allowances, keyed by a guest id that is not an account",
  job_schedule_outcomes: "job scheduling",
  job_schedules: "job scheduling",
  jobs: "background work (tenant duties; no job is enqueued per user)",
  permissions: "the permission catalog",
  platform_config: "configuration; updated_by records who made an administrative change",
  platform_config_history:
    "configuration history; changed_by records who made an administrative change",
  purge_log: "the record of an erasure, which must outlive it",
  role_inheritance: "the role catalog",
  role_permissions:
    "the role catalog; granted_by records who made an administrative change",
  roles: "the role catalog",
  tenant_config_overrides:
    "tenant configuration; updated_by records who made an administrative change",
  tenant_domains: "tenant routing",
  tenant_lifecycle_requests:
    "tenant lifecycle; requested_by and decided_by record operators' acts",
  tenants: "the tenant directory",
  user_deletions:
    "the record of an erasure, which must outlive it (a banned address only as a hash, A-11)",
};

/** The same reason for several columns. */
const each = (columns: readonly string[], reason: string): Record<string, string> =>
  Object.fromEntries(columns.map((c) => [c, reason]));

/**
 * Every column of a kind that can hold an identity or a text — uuid, text and the other string
 * types, arrays of them, json and jsonb — that no register entry erases, with the reason (review
 * 8 M3: the coverage test found candidates by name, on plain tables only, so a `reviewer_id
 * uuid`, a `requester_email text`, a `participant_ids text[]`, a json column or a partitioned
 * table went unseen). The reasons are of four kinds: a key or a fixed value that names no one;
 * the record of an administrative act or of an erasure, kept by design; the row's owner's own
 * data, deleted with the owner's rows (a mention of someone else in it is the owner's writing);
 * a catalog or configuration.
 */
export const NO_USER_DATA_COLUMNS: Readonly<Record<string, string>> = {
  ...each(
    [
      "agent_approval_policy.id",
      "agent_budgets.id",
      "agent_trajectories.id",
      "ai_metrics.id",
      "audit_log.id",
      "config_pending_approvals.id",
      "consent_records.id",
      "content_safety_audit.id",
      "deletion_manifest.id",
      "document_embeddings.id",
      "effect_ledger.id",
      "entitlement_groups.id",
      "entitlement_permissions.id",
      "group_invites.id",
      "group_memberships.id",
      "groups.id",
      "job_schedule_outcomes.id",
      "jobs.id",
      "password_policy.id",
      "permissions.id",
      "platform_config_history.id",
      "proposals.id",
      "purge_log.id",
      "review_queue.id",
      "role_inheritance.id",
      "role_permissions.id",
      "roles.id",
      "tenant_lifecycle_requests.id",
      "tenants.id",
      "user_devices.id",
      "user_entitlements.id",
      "user_interactions.id",
      "user_strikes.id",
    ],
    "the row's own generated key"
  ),
  ...each(
    [
      "agent_budgets.agent_id",
      "content_safety_audit.agent_id",
      "user_strikes.agent_id",
      "agent_trajectories.subject_kind",
      "agent_trajectories.trigger",
      "agent_budgets.period",
      "ai_metrics.name",
      "content_safety_audit.categories_flagged",
      "content_safety_audit.context_factors",
      "content_safety_audit.severity",
      "consent_records.consent_type",
      "consent_records.consent_version",
      "proposals.actor_role",
      "proposals.effective_risk",
      "proposals.label",
      "proposals.status",
      "review_queue.decision",
      "review_queue.modified_action",
      "review_queue.previous_account_status",
      "review_queue.priority",
      "review_queue.source",
      "review_queue.status",
      "user_feature_restrictions.feature",
      "user_interactions.feature",
      "user_strikes.category",
      "user_strikes.severity",
      "users.language_preference",
      "users.timezone",
    ],
    "a fixed value — an agent's or feature's name, a kind, a status or a category — never an account"
  ),
  ...each(
    [
      "agent_trajectories.total_cost",
      "ai_metrics.values",
      "ai_metrics.trace_id",
      "content_safety_audit.request_id",
      "content_safety_audit.trajectory_id",
      "content_safety_audit.input_hash",
      "review_queue.request_id",
      "review_queue.original_decision_id",
      "review_queue.related_strike_id",
      "user_strikes.trajectory_id",
      "user_strikes.guardian_decision_id",
      "user_strikes.moderation_audit_id",
      "proposals.operation_id",
      "proposals.trajectory_id",
      "proposals.run_token",
      "agent_trajectories.previous_trajectory_id",
      "agent_trajectories.chain_root_id",
      "app_sessions.id",
      "app_sessions.produced_by",
      "document_embeddings.chunk_id",
      "document_embeddings.document_id",
      "group_invites.group_id",
      "group_memberships.group_id",
      "password_policy.role_id",
      "users.role_id",
      "user_entitlements.entitlement_group_id",
    ],
    "an id of a request, run, record, document, group or role, or a number — not an account"
  ),
  "agent_trajectories.subject_id":
    "the run's subject: an agent or a session (a check allows no other kind); a session's run is found through its session",
  "proposals.session_id":
    "the session a held action was proposed in (an id the caller chose, not an account)",
  "content_safety_audit.classifier_output":
    "the classifier's verdict (categories, scores) — never the screened text",
  "content_safety_audit.reasoning":
    "the Guardian's reasoning, built from fixed phrases and the thresholds — never the screened text",
  "document_embeddings.metadata":
    "a document's own description; whose documents they are is in scope_key (documents)",
  "document_embeddings.content":
    "a document's text, deleted with its owner's documents (documents); a mention of someone else in it is the owner's writing",
  "user_interactions.input":
    "the user's own input, deleted with their interactions (aiInteractions)",
  "user_interactions.output":
    "the answer the user was given, deleted with their interactions (aiInteractions)",
  "groups.name": "a group's own name, deleted with its owner's groups (groupsOwned)",
  "groups.description":
    "a group's own description, deleted with its owner's groups (groupsOwned)",
  "groups.metadata": "a group's settings",
  "review_queue.appeal_reason":
    "the appellant's own text, deleted with their cases (reviewItems); a mention of someone else in it is the appellant's writing",
  "review_queue.reviewer_notes":
    "a reviewer's notes on a case, deleted with the case's account (reviewItems); kept, as the decision's record, when the reviewer is erased",
  "user_feature_restrictions.reason":
    "why a restriction was set (staff's text about the restricted account, deleted with it)",
  "user_strikes.reason":
    "a strike's reason (the Sentinel's text from the category), deleted with the account's strikes",
  "consent_records.user_agent":
    "the browser the account's own consent was given in, deleted with it (consents)",
  "user_devices.device_id": "a device's own id, deleted with the account's devices",
  "user_devices.device_name": "a device's own name, deleted with the account's devices",
  "audit_log.actor_id":
    "the security record keeps the account's id, which no longer names anyone (Article 17(3)(e), auditLog)",
  "audit_log.target_id":
    "the security record keeps the account's id, which no longer names anyone (Article 17(3)(e), auditLog)",
  "audit_log.user_agent":
    "the browser of whoever acted; cleared on the erased account's own rows (auditLog)",
  "users.id": "the account's own key: its row is deleted (profile)",
  "users.cognito_sub":
    "the account's own identity-provider subject, deleted with its row (profile)",
  "users.email":
    "the account's own address: removed at the soft delete, the row deleted at the purge (profile)",
  "users.display_name": "the account's own name, deleted with its row (profile)",
  "users.real_name": "the account's own name, deleted with its row (profile)",
  "users.avatar_url": "the account's own picture, deleted with its row (profile)",
  "users.parental_consent_email":
    "a child account's parent's address, deleted with the child's row (profile)",
  "users.ban_reason":
    "staff's reason for the account's own ban, deleted with its row (profile)",
  // The record of an administrative act, kept by design.
  "agent_approval_policy.decided_by":
    "the approval policy's author (an administrative act)",
  "agent_approval_policy.default_approver":
    "the approval policy's default approver (an administrative setting)",
  "agent_approval_policy.rules": "the approval policy's rules (no account named)",
  "config_pending_approvals.requested_by": "who asked for an administrative change",
  "config_pending_approvals.reviewed_by": "who decided an administrative change",
  "config_pending_approvals.current_value": "a setting's value",
  "config_pending_approvals.proposed_value": "a setting's value",
  "config_pending_approvals.action": "an administrative change's kind",
  "config_pending_approvals.config_key": "a setting's key",
  "config_pending_approvals.scope": "a setting's scope",
  "config_pending_approvals.change_comment":
    "an administrator's comment on a setting change (an administrative act)",
  "config_pending_approvals.impact_summary": "what a setting change would do",
  "config_pending_approvals.review_comment":
    "an administrator's comment on a decision (an administrative act)",
  "entitlement_groups.created_by":
    "the entitlement catalog's author (an administrative act)",
  "entitlement_groups.code": "the entitlement catalog",
  "entitlement_groups.description": "the entitlement catalog",
  "entitlement_groups.display_name": "the entitlement catalog",
  "entitlement_permissions.entitlement_group_id": "the entitlement catalog",
  "entitlement_permissions.permission_id": "the entitlement catalog",
  "permissions.category": "the permission catalog",
  "permissions.code": "the permission catalog",
  "permissions.description": "the permission catalog",
  "permissions.display_name": "the permission catalog",
  "role_inheritance.inherits_from_id": "the role catalog",
  "role_inheritance.role_id": "the role catalog",
  "role_permissions.granted_by": "who made an administrative change",
  "role_permissions.permission_id": "the role catalog",
  "role_permissions.role_id": "the role catalog",
  "roles.description": "the role catalog",
  "roles.display_name": "the role catalog",
  "roles.name": "the role catalog",
  "platform_config.allowed_values": "a setting's definition",
  "platform_config.category": "a setting's definition",
  "platform_config.default_value": "a setting's definition",
  "platform_config.description": "a setting's definition",
  "platform_config.key": "a setting's definition",
  "platform_config.max_value": "a setting's definition",
  "platform_config.min_value": "a setting's definition",
  "platform_config.permission_tier": "a setting's definition",
  "platform_config.value_type": "a setting's definition",
  "platform_config.value": "a setting's value",
  "platform_config.updated_by": "who made an administrative change",
  "platform_config_history.changed_by": "who made an administrative change",
  "platform_config_history.change_comment":
    "an administrator's comment on a change (an administrative act)",
  "platform_config_history.change_source": "where a change came from (route, assistant)",
  "platform_config_history.config_key": "a setting's key",
  "platform_config_history.scope": "a setting's scope",
  "platform_config_history.new_value": "a setting's value",
  "platform_config_history.previous_value": "a setting's value",
  "tenant_config_overrides.key": "a tenant setting's key",
  "tenant_config_overrides.updated_by": "who made an administrative change",
  "tenant_config_overrides.value": "a setting's value",
  "tenant_domains.host": "tenant routing",
  "tenant_lifecycle_requests.action": "tenant lifecycle",
  "tenant_lifecycle_requests.decided_by": "an operator's act",
  "tenant_lifecycle_requests.decision_note": "an operator's act",
  "tenant_lifecycle_requests.reason": "an operator's act",
  "tenant_lifecycle_requests.requested_by": "an operator's act",
  "tenant_lifecycle_requests.status": "tenant lifecycle",
  "tenants.name": "the tenant directory",
  "tenants.slug": "the tenant directory",
  "tenants.status": "the tenant directory",
  "tenants.status_changed_by": "an operator's act on a tenant",
  "tenants.status_reason": "an operator's act on a tenant",
  // The record of an erasure, which must outlive it.
  "purge_log.purge_id": "the record of an erasure, which must outlive it",
  "purge_log.reason": "the record of an erasure, which must outlive it",
  "purge_log.requested_by": "the record of an erasure, which must outlive it",
  "purge_log.status": "the record of an erasure, which must outlive it",
  "purge_log.steps_json": "the record of an erasure, which must outlive it",
  "purge_log.user_id": "the record of an erasure, which must outlive it",
  "user_deletions.email_hash":
    "the record of an erasure: a banned address only as a keyed hash (A-11)",
  "user_deletions.email_hash_key": "which key made the hash (review 8 L6)",
  "user_deletions.email_hash_scheme": "how the hash was made, recorded (review 9 M6)",
  "user_deletions.modules": "the record of an erasure, which must outlive it",
  "user_deletions.requested_by": "the record of an erasure, which must outlive it",
  "user_deletions.standing": "the record of an erasure, which must outlive it",
  "user_deletions.user_id": "the record of an erasure, which must outlive it",
  "user_deletions.cognito_sub":
    "the record of an erasure: the identity it closed, never provisioned again (TASK-174)",
  // The platform's own machinery.
  "applied_migrations.confidence": "schema history",
  "applied_migrations.filename": "schema history",
  "applied_migrations.note": "schema history",
  "config_dual_control_seeded.key": "which dual-control keys a migration seeded",
  "config_dual_control_seeded.outcome": "which dual-control keys a migration seeded",
  "config_dual_control_seeded.seeded_by": "which dual-control keys a migration seeded",
  "deletion_manifest.description": "the registry of deletion modules",
  "deletion_manifest.module_name": "the registry of deletion modules",
  "deletion_manifest.table_names": "the registry of deletion modules",
  "effect_ledger.effect_key": "the receipt of an external call, keyed by its operation",
  "effect_ledger.effect_type": "the receipt of an external call, keyed by its operation",
  "effect_ledger.error": "the receipt of an external call, keyed by its operation",
  "effect_ledger.idempotency_key":
    "the receipt of an external call, keyed by its operation",
  "effect_ledger.operation_id": "the receipt of an external call, keyed by its operation",
  "effect_ledger.receipt": "the receipt of an external call, keyed by its operation",
  "effect_ledger.request": "the receipt of an external call, keyed by its operation",
  "effect_ledger.status": "the receipt of an external call, keyed by its operation",
  "guest_usage.guest_id": "a guest id, which is not an account",
  "job_schedule_outcomes.kind": "job scheduling",
  "job_schedule_outcomes.last_error": "job scheduling",
  "job_schedule_outcomes.status": "job scheduling",
  "job_schedules.kind": "job scheduling",
  "jobs.idempotency_key": "background work",
  "jobs.kind": "background work",
  "jobs.last_error": "background work",
  "jobs.lease_token": "background work",
  "jobs.locked_by": "the worker holding a job",
  "jobs.source": "background work",
  "jobs.status": "background work",
  "jobs.payload":
    "the platform enqueues no job naming a user; an app whose jobs do erases them in its deletion module",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What erasure did to one register entry. */
export interface ErasureStep {
  readonly name: string;
  readonly table: string;
  readonly action: "deleted" | "anonymised";
  readonly rows: number;
}

/**
 * Erase the user's data from every table of the register, in `tx` (the caller's tenant
 * transaction). Any failure throws, and the transaction rolls the whole erasure back: a partial
 * erasure is never committed. `dryRun` counts the rows instead.
 */
export async function eraseUserData(
  tx: Tx,
  userId: string,
  options: { readonly dryRun?: boolean } = {}
): Promise<readonly ErasureStep[]> {
  if (!UUID.test(userId)) throw new Error("invalid user id");
  // Ids are stored lower-case; text columns compare as text.
  const id = userId.toLowerCase();
  const steps: ErasureStep[] = [];
  for (const entry of USER_DATA_TABLES) {
    const rows = options.dryRun
      ? Number((await tx.query<{ n: number }>(entry.count, [id])).rows[0]?.n ?? 0)
      : (await tx.query(entry.erase, [id])).rowCount;
    steps.push({
      name: entry.name,
      table: entry.table,
      action: entry.action === "delete" ? "deleted" : "anonymised",
      rows,
    });
  }
  return steps;
}

/** Rows read per statement on export. */
export const EXPORT_PAGE_SIZE = 500;

/**
 * The most rows one export holds, over every section. An export with more is refused whole with
 * ExportTooLargeError (the route answers `account.export_too_large`) — never cut off.
 */
export const EXPORT_MAX_ROWS = 100_000;

/** The export would hold more than EXPORT_MAX_ROWS rows: it is not given (never truncated). */
export class ExportTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`export.too_large: the export holds more than ${limit} rows`);
    this.name = "ExportTooLargeError";
  }
}

/** The tid before every row: the first page starts after it. */
const BEFORE_FIRST = "(0,0)";

/**
 * Every row of every exported register entry, read in `tx` page by page (EXPORT_PAGE_SIZE rows,
 * ordered by key), until a page comes back short. `tx` should be one snapshot (data-export reads
 * in withTenantSnapshot), so no row is read twice or missed between pages. Any failed read
 * throws: an export is complete or it is not given (audit RR-23). Over `maxRows` rows in all,
 * ExportTooLargeError — never a silent cut (review 7 M2: each section stopped at 1000 rows, and
 * nothing said so).
 */
export async function exportUserTables(
  tx: Tx,
  userId: string,
  options: { readonly pageSize?: number; readonly maxRows?: number } = {}
): Promise<Record<string, Record<string, unknown>[]>> {
  if (!UUID.test(userId)) throw new Error("invalid user id");
  const id = userId.toLowerCase();
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  const maxRows = options.maxRows ?? EXPORT_MAX_ROWS;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize");
  const out: Record<string, Record<string, unknown>[]> = {};
  let total = 0;
  for (const entry of USER_DATA_TABLES) {
    if (!entry.exportSql) continue;
    const rows: Record<string, unknown>[] = [];
    let after = BEFORE_FIRST;
    for (;;) {
      const page = await tx.query<{ r: Record<string, unknown>; k: string }>(
        entry.exportSql,
        [id, pageSize, after]
      );
      for (const row of page.rows) rows.push(row.r);
      total += page.rows.length;
      if (total > maxRows) throw new ExportTooLargeError(maxRows);
      if (page.rows.length < pageSize) break;
      after = page.rows[page.rows.length - 1].k;
    }
    out[entry.name] = rows;
  }
  return out;
}
