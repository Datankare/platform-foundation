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
import { AUDIT_TEXT_KEYS } from "@/platform/auth/audit-details";
import { PURGE_REASONS } from "@/platform/gdpr/types";
import { NOTE_ERASED, NOTE_ONLY } from "@/platform/errors/recorded-text";

/**
 * The schema's free-text keys as a SQL text array (TASK-194 rebase, I-1): built from
 * AUDIT_TEXT_KEYS, so the erasure's list cannot drift from the schema. Each key is a plain
 * identifier — checked here, so nothing but a key's own letters reaches the statement.
 */
const AUDIT_TEXT_ARRAY = `array[${AUDIT_TEXT_KEYS.map((k) => {
  if (!/^[a-z_]\w*$/i.test(k)) {
    throw new Error(`audit text key ${JSON.stringify(k)} is not a plain identifier`);
  }
  return `'${k}'`;
}).join(", ")}]`;

/**
 * An erasure's listed reasons as a SQL text array (round 9, I-3): the only reason an erasure hold
 * about the account keeps (platform/gdpr/types.ts PURGE_REASONS) — any other is free text.
 */
const PURGE_REASON_ARRAY = `array[${PURGE_REASONS.map((r) => {
  if (!/^[a-z-]+$/.test(r))
    throw new Error(`purge reason ${JSON.stringify(r)} is not a plain code`);
  return `'${r}'`;
}).join(", ")}]::text[]`;

/**
 * The note left where one about an erased account was (TASK-208, N-110): the catalog's key, never
 * English — rendered where the record is shown (the subject's export, recorded-text.ts).
 */
const NOTE_ERASED_SQL = `jsonb_build_object('key', '${NOTE_ERASED.key}')`;

/**
 * The user's id as a LIKE pattern for "anywhere in this text" (round 10, P-A): a cheap prefilter
 * before a statement looks inside a run's steps. A UUID has no LIKE metacharacters, but a
 * backslash, `%` and `_` are escaped all the same.
 */
const LIKE_ID = `'%' || replace(replace(replace($1::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;

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
    // TASK-215 (audit A-5, A-6): the record kept its screened text's hash — unkeyed until then,
    // so a guess of what the person wrote could be confirmed against it after the erasure — and the
    // classifier model's own words, which can quote that text. The account's decisions lose both:
    // the hash is cleared and any model words left from before are removed.
    reason:
      "the decision record is kept unattributed for the safety statistics; it keeps nothing of what the person wrote — the screened text's hash is cleared, and no model words",
    count: "select count(*)::int as n from content_safety_audit where user_id = $1",
    erase:
      "update content_safety_audit set user_id = null, input_hash = null, classifier_output = classifier_output - 'rawReason' - 'reason' where user_id = $1",
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
  // The run of such a held action ends with it (TASK-193, audit B-2): the hold is deleted next,
  // and its trajectory was left paused for good.
  {
    name: "heldAboutTrajectories",
    table: "agent_trajectories",
    action: "anonymise",
    reason:
      "the run of a held action about an erased account is ended (failed); the hold itself is deleted next (proposalsHeldAbout)",
    columns: [],
    count:
      "select count(*)::int as n from agent_trajectories where status in ('running', 'paused', 'awaiting_retry', 'indeterminate') and id::text in (select trajectory_id from proposals where status in ('proposed', 'approved') and (jsonb_path_exists(payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) or jsonb_path_exists(effects, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text))))",
    erase:
      "update agent_trajectories set status = 'failed', version = version + 1, updated_at = now() where status in ('running', 'paused', 'awaiting_retry', 'indeterminate') and id::text in (select trajectory_id from proposals where status in ('proposed', 'approved') and (jsonb_path_exists(payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) or jsonb_path_exists(effects, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text))))",
    exportReason: "another account's held action about the user (proposalsHeldAbout)",
  },
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
  // Round 8, item 3: the run of a decided hold about the account records the decision in a step
  // (gating.ts endHeldTrajectory: its output's `note`, the decider's or the run's text); that
  // note is replaced — the step itself stands. Before proposalsAbout replaces the id it is found
  // by.
  {
    name: "heldAboutStepNotes",
    table: "agent_trajectories",
    action: "anonymise",
    reason:
      "the run of a decided hold about the account stands; the note written about the account in its steps is erased",
    columns: [],
    count:
      "select count(*)::int as n from agent_trajectories a where jsonb_typeof(a.steps) = 'array' and exists (select 1 from proposals p where p.trajectory_id = a.id::text and jsonb_path_exists(p.payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text))) and exists (select 1 from jsonb_array_elements(a.steps) s(step) where s.step->'output' ? 'note' and s.step->>'proposalId' in (select p.id::text from proposals p where p.trajectory_id = a.id::text and jsonb_path_exists(p.payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text))))",
    erase: `update agent_trajectories a set steps = (select coalesce(jsonb_agg(case when s.step->'output' ? 'note' and s.step->>'proposalId' in (select p.id::text from proposals p where p.trajectory_id = a.id::text and jsonb_path_exists(p.payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text))) then jsonb_set(s.step, '{output,note}', ${NOTE_ERASED_SQL}) else s.step end order by s.n), '[]'::jsonb) from jsonb_array_elements(a.steps) with ordinality as s(step, n)) where jsonb_typeof(a.steps) = 'array' and exists (select 1 from proposals p where p.trajectory_id = a.id::text and jsonb_path_exists(p.payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text))) and exists (select 1 from jsonb_array_elements(a.steps) s(step) where s.step->'output' ? 'note' and s.step->>'proposalId' in (select p.id::text from proposals p where p.trajectory_id = a.id::text and jsonb_path_exists(p.payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text))))`,
    exportReason: "another account's held action about the user (proposalsAbout)",
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
      "proposals.decision_shown",
      "proposals.last_run_error",
      "proposals.actor_identity",
    ],
    count:
      "select count(*)::int as n from proposals where payload::text ~* $1::text or effects::text ~* $1::text or coalesce(decision_note, '') ~* $1::text or coalesce(decision_shown::text, '') ~* $1::text or coalesce(last_run_error, '') ~* $1::text or coalesce(actor_identity::text, '') ~* $1::text",
    // Round 8, item 3: a decided hold about the account (its id a value in the payload) loses the
    // free text written about it — the decider's note, and the requester's reason (a
    // restriction's; an erasure's reason is a listed code, PURGE_REASONS, and stays) — not only
    // the id in them.
    erase: `update proposals set payload = case when jsonb_path_exists(payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) and jsonb_typeof(payload) = 'object' then regexp_replace(payload::text, $1::text, 'erased', 'gi')::jsonb - (case when label = 'purge_user_data' and payload->>'reason' = any(${PURGE_REASON_ARRAY}) then array_remove(${AUDIT_TEXT_ARRAY}, 'reason') else ${AUDIT_TEXT_ARRAY} end) else regexp_replace(payload::text, $1::text, 'erased', 'gi')::jsonb end, effects = regexp_replace(effects::text, $1::text, 'erased', 'gi')::jsonb, decision_note = case when decision_note is not null and jsonb_path_exists(payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) then null else regexp_replace(decision_note, $1::text, 'erased', 'gi') end, decision_shown = case when decision_note is not null and jsonb_path_exists(payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) then jsonb_set(coalesce(regexp_replace(decision_shown::text, $1::text, 'erased', 'gi')::jsonb, jsonb_build_object('key', '${NOTE_ONLY}', 'params', '{}'::jsonb)), '{params,note}', ${NOTE_ERASED_SQL}) else regexp_replace(decision_shown::text, $1::text, 'erased', 'gi')::jsonb end, last_run_error = regexp_replace(last_run_error, $1::text, 'erased', 'gi'), actor_identity = regexp_replace(actor_identity::text, $1::text, 'erased', 'gi')::jsonb where payload::text ~* $1::text or effects::text ~* $1::text or coalesce(decision_note, '') ~* $1::text or coalesce(decision_shown::text, '') ~* $1::text or coalesce(last_run_error, '') ~* $1::text or coalesce(actor_identity::text, '') ~* $1::text`,
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
  // Round 9, I-1: a run's step about the account keeps no free text about it. Two writers record an
  // action's input as a step's input: a held action's proposal step (action-pipeline proposeAction:
  // its payload), and an agent run's step (agents/runtime.ts: what its workflow returned as the
  // step's input) — a restriction's reason among them. (A tool run, held or not, records only its
  // tool's id — tool-invoker's stepInput — and every other step only its ids.) Every step whose
  // input names the account anywhere (its id a value there: an account the step acts on, or the
  // actor who took it) loses its free-text keys — the audit schema's text keys (AUDIT_TEXT_KEYS),
  // one register for both — except an erasure's listed reason (PURGE_REASONS). Round 10, N-B: that
  // is the rule on purpose — the erased user's own steps and another person's steps about them
  // alike, since text beside the id may be about them; it may erase text about someone else in the
  // same step (over-erasure, the safe direction), never keep text about them. A step that does not
  // name them is left as it is. Matched by the step's own input, so a hold deleted
  // (proposalsHeldAbout) or decided, and a run with no hold at all, are all covered; before
  // trajectorySteps replaces the id it is found by. (Not at the source: the approved run's own step
  // records the same input, and rows written before stand — the erasure is the one place that
  // reaches all of them.) Each statement first prefilters on the id anywhere in the steps' text
  // (LIKE_ID, round 10, P-A).
  {
    name: "stepFreeText",
    table: "agent_trajectories",
    action: "anonymise",
    reason:
      "a run's step about the account stands; the free text written about the account in its input is erased",
    columns: [],
    count: `select count(*)::int as n from agent_trajectories a where jsonb_typeof(a.steps) = 'array' and a.steps::text ilike ${LIKE_ID} and exists (select 1 from jsonb_array_elements(a.steps) s(step) where jsonb_typeof(s.step->'input') = 'object' and jsonb_path_exists(s.step->'input', '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) and (s.step->'input') ?| (case when s.step->>'action' = 'purge_user_data' and s.step->'input'->>'reason' = any(${PURGE_REASON_ARRAY}) then array_remove(${AUDIT_TEXT_ARRAY}, 'reason') else ${AUDIT_TEXT_ARRAY} end))`,
    erase: `update agent_trajectories a set steps = (select coalesce(jsonb_agg(case when jsonb_typeof(s.step->'input') = 'object' and jsonb_path_exists(s.step->'input', '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) and (s.step->'input') ?| (case when s.step->>'action' = 'purge_user_data' and s.step->'input'->>'reason' = any(${PURGE_REASON_ARRAY}) then array_remove(${AUDIT_TEXT_ARRAY}, 'reason') else ${AUDIT_TEXT_ARRAY} end) then jsonb_set(s.step, '{input}', (s.step->'input') - (case when s.step->>'action' = 'purge_user_data' and s.step->'input'->>'reason' = any(${PURGE_REASON_ARRAY}) then array_remove(${AUDIT_TEXT_ARRAY}, 'reason') else ${AUDIT_TEXT_ARRAY} end)) else s.step end order by s.n), '[]'::jsonb) from jsonb_array_elements(a.steps) with ordinality as s(step, n)) where jsonb_typeof(a.steps) = 'array' and a.steps::text ilike ${LIKE_ID} and exists (select 1 from jsonb_array_elements(a.steps) s(step) where jsonb_typeof(s.step->'input') = 'object' and jsonb_path_exists(s.step->'input', '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) and (s.step->'input') ?| (case when s.step->>'action' = 'purge_user_data' and s.step->'input'->>'reason' = any(${PURGE_REASON_ARRAY}) then array_remove(${AUDIT_TEXT_ARRAY}, 'reason') else ${AUDIT_TEXT_ARRAY} end))`,
    exportReason: "the run's steps the user took are exported as trajectorySteps",
  },
  // TASK-215 (audit A-5: what an erased account wrote, wherever it survives). A session the user
  // shared with others stands for them (sharedAppSessions), and so does its run; the user's own
  // moves in it (steps whose actor is the user) kept what they entered and what it produced — only
  // their id was replaced (trajectorySteps), so their words stayed, unattributed. Those moves now
  // keep their action and time; their input and output are emptied ({}, the step's shape kept).
  // This runs before trajectorySteps replaces the id the moves are found by. The session's state is
  // the participants' together (an app that keeps a participant's words in it erases them in its
  // deletion module).
  {
    name: "sessionMoveText",
    table: "agent_trajectories",
    action: "anonymise",
    reason:
      "a shared session's run stands for the others in it; what the user entered in their own moves, and what those moves produced, is removed",
    columns: [],
    count:
      "select count(*)::int as n from agent_trajectories a where a.subject_kind = 'session' and jsonb_typeof(a.steps) = 'array' and a.steps @> jsonb_build_array(jsonb_build_object('actor', jsonb_build_object('actorId', $1::text))) and exists (select 1 from jsonb_array_elements(a.steps) s(step) where s.step->'actor'->>'actorId' = $1::text and (coalesce(s.step->'input', '{}'::jsonb) <> '{}'::jsonb or coalesce(s.step->'output', '{}'::jsonb) <> '{}'::jsonb))",
    erase:
      "update agent_trajectories a set steps = (select coalesce(jsonb_agg(case when s.step->'actor'->>'actorId' = $1::text then s.step || jsonb_build_object('input', '{}'::jsonb, 'output', '{}'::jsonb) else s.step end order by s.n), '[]'::jsonb) from jsonb_array_elements(a.steps) with ordinality as s(step, n)) where a.subject_kind = 'session' and jsonb_typeof(a.steps) = 'array' and a.steps @> jsonb_build_array(jsonb_build_object('actor', jsonb_build_object('actorId', $1::text))) and exists (select 1 from jsonb_array_elements(a.steps) s(step) where s.step->'actor'->>'actorId' = $1::text and (coalesce(s.step->'input', '{}'::jsonb) <> '{}'::jsonb or coalesce(s.step->'output', '{}'::jsonb) <> '{}'::jsonb))",
    exportReason: "the run's steps the user took are exported as trajectorySteps",
  },
  {
    name: "trajectorySteps",
    table: "agent_trajectories",
    action: "anonymise",
    reason:
      "a run others took part in stands for them; the user's id in its steps is replaced",
    columns: ["agent_trajectories.steps", "agent_trajectories.scope_id"],
    count: `select count(*)::int as n from agent_trajectories where (steps::text ilike ${LIKE_ID} or scope_id = $1::text) and (steps::text ~* $1::text or scope_id = $1::text) and not coalesce(scope_type = 'user' and scope_id = $1, false) and not (subject_kind = 'session' and subject_id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1))`,
    erase: `update agent_trajectories set steps = regexp_replace(steps::text, $1::text, 'erased', 'gi')::jsonb, scope_id = case when scope_id = $1::text then 'erased' else scope_id end where (steps::text ilike ${LIKE_ID} or scope_id = $1::text) and (steps::text ~* $1::text or scope_id = $1::text) and not coalesce(scope_type = 'user' and scope_id = $1, false) and not (subject_kind = 'session' and subject_id in (select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1))`,
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
  // ── Sign-in sessions (ADR-057: keyed by the identity's subject — the account's cognito_sub,
  // or its id for an account that has none) ────────────────────────────────────────────────
  {
    name: "signInSessions",
    table: "auth_sessions",
    action: "delete",
    columns: ["auth_sessions.subject"],
    count:
      "select count(*)::int as n from auth_sessions where (lower(subject) = lower($1::text) or subject in (select cognito_sub from users where id = $1::uuid and cognito_sub is not null))",
    erase:
      "delete from auth_sessions where (lower(subject) = lower($1::text) or subject in (select cognito_sub from users where id = $1::uuid and cognito_sub is not null))",
    exportSql:
      "select to_jsonb(t) - '_k' as r, t._k::text as k from (select method, created_at, last_seen_at, revoked_at, revoked_reason, ctid as _k from auth_sessions where (lower(subject) = lower($1::text) or subject in (select cognito_sub from users where id = $1::uuid and cognito_sub is not null)) and ctid > $3::tid order by ctid limit $2::int) t",
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
  // TASK-193 (audit A-4): free text a person wrote about the account — a restriction's reason, a
  // reviewer's notes — is erased with it, from every record ABOUT the account (its target, or the
  // user_id / userId it names: review round 1, item 6) — never from a record that only names it as
  // the requester or approver of an act about someone else, whose text is about that someone. The
  // record of the act stands (AUDIT_TEXT_KEYS, platform/auth/audit-details.ts; the list here is
  // built from it: AUDIT_TEXT_ARRAY). Before the id is replaced below.
  {
    name: "auditText",
    table: "audit_log",
    action: "anonymise",
    columns: [],
    reason:
      "the record of an act about the account stands; the free text written about the account in it is erased",
    count: `select count(*)::int as n from audit_log where (target_id = $1::uuid or details->>'user_id' = $1::text or details->>'userId' = $1::text) and details ?| ${AUDIT_TEXT_ARRAY}`,
    erase: `update audit_log set details = (details - ${AUDIT_TEXT_ARRAY}) || jsonb_build_object('textErased', true) where (target_id = $1::uuid or details->>'user_id' = $1::text or details->>'userId' = $1::text) and details ?| ${AUDIT_TEXT_ARRAY}`,
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
  provider_usage:
    "a prepaid provider's running count of billed requests (TASK-212): no person's",
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
    "the classifier's verdict as codes — its categories, severity and confidence, and the platform's note as a catalog key. Not the screened text, and no longer the model's own words about it (TASK-215, audit A-5: before, its `rawReason` could quote what the person wrote; migration 072 removed it from the rows written before, and the account's erasure removes any left)",
  "content_safety_audit.input_hash":
    "a keyed hash of the screened text (RECORD_HASH_KEY, TASK-215, audit A-6) — never an account; cleared on the erased account's own decisions (moderationDecisions), so no guess of what they wrote can be confirmed against it",
  "content_safety_audit.reasoning":
    "the Guardian's reasoning as recorded before its keys (TASK-209), built from fixed phrases and the thresholds — never the screened text",
  "content_safety_audit.reasoning_shown":
    "the Guardian's reasoning as catalog keys and values (TASK-209): fixed phrases and the thresholds — never the screened text",
  "content_safety_audit.context_factors_shown":
    "the decision's context factors as catalog keys and values (TASK-209): a content type, languages, counts — not an account",
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
  "review_queue.notes_shown":
    "the platform's own note on a decision it made (a catalog key and values: TASK-209), deleted with the case's account (reviewItems)",
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
  "users.ban_note":
    "the platform's note on the account's own ban (a catalog key: TASK-208), deleted with its row (profile)",
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
  "config_pending_approvals.impact_summary":
    "what a setting change would do (written before TASK-209; no longer written)",
  "config_pending_approvals.change_shown":
    "the platform's own note on a setting change request (a catalog key and values: TASK-209)",
  "config_pending_approvals.review_shown":
    "the system's record of a decision on an administrative change: why, and who had approved it (an administrative act; TASK-209)",
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
  "roles.description_note":
    "the role catalog: a screen message's key and a role's name (TASK-207)",
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
  "platform_config_history.change_shown":
    "the platform's own note on a setting change (a catalog key and values: TASK-209)",
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
  "user_deletions.last_purge_error":
    "the record of an erasure: the names of the steps a failed purge could not complete (TASK-193)",
  "user_deletions.external_erasures":
    "the record of an erasure: each store outside the database it reached, when and how often (TASK-193)",
  "user_deletions.identity_pool":
    "the record of an erasure: the identity pool it erased from — a pool's id, nothing of the person (TASK-193 round 1)",
  // The platform's own machinery.
  "applied_migrations.checksum": "schema history (a file checksum, TASK-197)",
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
  "auth_sessions.id_hash":
    "the SHA-256 of a random session id (ADR-057); names no one, and the row goes with its subject",
  "auth_sessions.kind": "user or guest (ADR-057)",
  "auth_sessions.method": "how the session was obtained: a fixed code (ADR-057)",
  "auth_sessions.csrf_token":
    "a random forgery token (ADR-057); names no one, and the row goes with its subject",
  "auth_sessions.sealed_tokens":
    "the provider's tokens, encrypted by the application (ADR-057); unreadable here, and the row goes with its subject",
  "auth_sessions.revoked_reason": "why the session ended: a fixed code (ADR-057)",
  "job_schedule_outcomes.kind": "job scheduling",
  "job_schedule_outcomes.last_error": "job scheduling",
  "job_schedule_outcomes.status": "job scheduling",
  "job_schedules.kind": "job scheduling",
  "provider_usage.provider": "a provider's name (TASK-212)",
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

/**
 * What a person's own export (Article 15, data-export) gives of their account row: every column of
 * `users`, given or not, and why (TASK-215, audit A-14). The profile was the whole row less one
 * column — so every column the table had, and every one a migration added later, went into the
 * file: the identity provider's subject, the tenant and role keys, and a child's parent's address.
 * `__tests__/db/export-columns.db.test.ts` fails on a column of `users` this does not classify, and
 * holds PROFILE_EXPORT_SQL to the columns given here: a new column is in no export until it is
 * classified, with its reason.
 */
export const PROFILE_COLUMNS: Readonly<
  Record<string, { readonly exported: boolean; readonly why: string }>
> = {
  id: { exported: true, why: "the account's own id: the export's reference to it" },
  email: { exported: true, why: "the person's own address, given by them" },
  display_name: { exported: true, why: "the person's own name, given by them" },
  real_name: { exported: true, why: "the person's own name, given by them" },
  avatar_url: { exported: true, why: "the person's own picture, given by them" },
  language_preference: { exported: true, why: "the person's own setting" },
  timezone: { exported: true, why: "the person's own setting" },
  profile_visibility: { exported: true, why: "the person's own setting" },
  display_name_visibility: { exported: true, why: "the person's own setting" },
  avatar_visibility: { exported: true, why: "the person's own setting" },
  language_visibility: { exported: true, why: "the person's own setting" },
  timezone_visibility: { exported: true, why: "the person's own setting" },
  email_opt_in: { exported: true, why: "the person's own choice" },
  push_notifications_enabled: { exported: true, why: "the person's own choice" },
  date_of_birth: { exported: true, why: "given by the person" },
  age_verified: { exported: true, why: "a fact the platform holds about the person" },
  age_verified_at: { exported: true, why: "a fact the platform holds about the person" },
  parental_consent_status: {
    exported: true,
    why: "whether a parent consented to a child's account: a fact about the person",
  },
  content_rating_level: { exported: true, why: "the person's own setting" },
  mfa_enabled: { exported: true, why: "a fact about the person's sign-in" },
  email_verified: { exported: true, why: "a fact about the person's address" },
  created_at: { exported: true, why: "when the account was made" },
  updated_at: { exported: true, why: "when the account last changed" },
  last_login_at: { exported: true, why: "when the person last signed in" },
  account_status: {
    exported: true,
    why: "a decision about the person (Article 15(1): the data and the processing's result)",
  },
  restricted_until: { exported: true, why: "a decision about the person" },
  suspended_until: { exported: true, why: "a decision about the person" },
  banned_at: { exported: true, why: "a decision about the person" },
  ban_reason: { exported: true, why: "the reason given for a decision about the person" },
  ban_note: {
    exported: true,
    why: "the platform's note on a decision about the person (rendered in the requester's words)",
  },
  status_changed_at: { exported: true, why: "when a decision about the person was made" },
  coppa_enforcement_active: {
    exported: true,
    why: "whether the children's-account rules apply to the person",
  },
  cognito_sub: {
    exported: false,
    why: "the identity provider's key for the sign-in, not something the person gave or the platform decided; the person sees their sign-in account at the provider, and a copy in an export file is a key into it",
  },
  parental_consent_email: {
    exported: false,
    why: "a parent's address: another person's data (Article 15(4)); the export says whether consent was given (parental_consent_status)",
  },
  status_changed_by: {
    exported: false,
    why: "the id of the moderator or administrator who changed the standing: another person's (review 7 M4); the decision and its time are exported",
  },
  role_id: {
    exported: false,
    why: "the role catalog's internal key; the role itself is exported by name (role)",
  },
  tenant_id: {
    exported: false,
    why: "the deployment's tenant key: how the platform stores the row, nothing about the person",
  },
  deleted_at: {
    exported: false,
    why: "always empty in an export: only a live account is exported (an erased one has nothing to give)",
  },
};

/**
 * The profile as an export gives it: PROFILE_COLUMNS' given columns, named (never the whole row),
 * and the role by name. A literal, so the schema-parity check plans it; the export-columns test
 * holds its keys to PROFILE_COLUMNS.
 */
export const PROFILE_EXPORT_SQL = `select jsonb_build_object(
    'id', u.id, 'email', u.email, 'display_name', u.display_name, 'real_name', u.real_name,
    'avatar_url', u.avatar_url, 'language_preference', u.language_preference,
    'timezone', u.timezone, 'profile_visibility', u.profile_visibility,
    'display_name_visibility', u.display_name_visibility,
    'avatar_visibility', u.avatar_visibility, 'language_visibility', u.language_visibility,
    'timezone_visibility', u.timezone_visibility, 'email_opt_in', u.email_opt_in,
    'push_notifications_enabled', u.push_notifications_enabled,
    'date_of_birth', u.date_of_birth, 'age_verified', u.age_verified,
    'age_verified_at', u.age_verified_at, 'parental_consent_status', u.parental_consent_status,
    'content_rating_level', u.content_rating_level, 'mfa_enabled', u.mfa_enabled,
    'email_verified', u.email_verified, 'created_at', u.created_at, 'updated_at', u.updated_at,
    'last_login_at', u.last_login_at, 'account_status', u.account_status,
    'restricted_until', u.restricted_until, 'suspended_until', u.suspended_until,
    'banned_at', u.banned_at, 'ban_reason', u.ban_reason, 'ban_note', u.ban_note,
    'status_changed_at', u.status_changed_at,
    'coppa_enforcement_active', u.coppa_enforcement_active,
    'role', (select r.name from roles r where r.id = u.role_id)
  ) as r
  from users u where u.id = $1::uuid and u.deleted_at is null`;

/** One column's place in a tenant's export: given or not, and why. */
export interface TenantExportColumn {
  readonly exported: boolean;
  readonly why: string;
}

/** The same decision, for several columns of one table. */
const tenantCols = (
  table: string,
  exported: boolean,
  why: string,
  columns: readonly string[]
): Record<string, TenantExportColumn> =>
  Object.fromEntries(columns.map((c) => [`${table}.${c}`, { exported, why }]));

/** Why the tenant key itself is never in the file: its first line names the tenant. */
const TENANT_KEY =
  "the tenant key: the export's first line names the tenant, and another deployment keys it its own way";
/** Why a network address and browser are not exported (audit A-7). */
const NETWORK =
  "a network address or browser: kept for security only for retention.network_identifiers_days, then cleared — an export would keep it past that, in a file the retention never reaches";
/** What the tenant gets of a table that is its records: everything it holds about its accounts. */
const RECORDS = "the tenant's own records";

/**
 * What the operator's export of a tenant (tenancy/admin.ts writeTenantExport, TASK-215, audit A-7)
 * gives of each column of each table that holds a tenant's rows: every column, given or not, and
 * why. The export read whole rows (`to_jsonb(r)`, migration 049) — erased accounts' residue,
 * network addresses, job tokens and every column a later migration added. Now it reads only the
 * columns given here (an app's own tables: its consumer seam, platform/tenancy/app-tenant-export.ts),
 * named, through tenant_export_rows (migration 071). `__tests__/db/export-columns.db.test.ts`
 * fails on a column of a tenant table that neither classifies, and on an entry naming no column: a
 * new column is in no export until it is classified, with its reason.
 */
export const TENANT_EXPORT_COLUMNS: Readonly<Record<string, TenantExportColumn>> = {
  ...tenantCols(
    "agent_approval_policy",
    true,
    "the tenant's approval policy and who set it",
    ["id", "version", "default_approver", "rules", "decided_by", "created_at"]
  ),
  ...tenantCols("agent_budgets", true, "the tenant's agents' spend counters", [
    "id",
    "agent_id",
    "scope_type",
    "scope_id",
    "period",
    "budget_tokens",
    "used_tokens",
    "budget_usd",
    "used_usd",
    "created_at",
    "updated_at",
    "used_steps",
  ]),
  ...tenantCols("agent_trajectories", true, "the tenant's agent runs and their steps", [
    "id",
    "trigger",
    "scope_type",
    "scope_id",
    "status",
    "steps",
    "total_cost",
    "started_at",
    "completed_at",
    "subject_kind",
    "subject_id",
    "version",
    "created_at",
    "updated_at",
    "segment",
    "previous_trajectory_id",
    "step_offset",
    "chain_root_id",
  ]),
  ...tenantCols("ai_metrics", true, "the tenant's AI usage", [
    "id",
    "name",
    "timestamp",
    "trace_id",
    "values",
    "tags",
    "created_at",
  ]),
  ...tenantCols("app_sessions", true, "the tenant's app sessions", [
    "id",
    "state",
    "version",
    "produced_by",
    "created_at",
    "updated_at",
    "meta",
  ]),
  ...tenantCols("audit_log", true, "the tenant's audit record: who did what, when", [
    "id",
    "action",
    "actor_id",
    "target_id",
    "details",
    "created_at",
  ]),
  ...tenantCols("audit_log", false, NETWORK, ["ip_address", "user_agent"]),
  // TASK-214's sign-in sessions (ADR-057), classified by TASK-215: a credential, not a record — the
  // session id's hash, the provider's tokens sealed under SESSION_ENCRYPTION_KEY, the forgery-check
  // token — kept from minutes to days and revoked on sign-out; an export would carry a credential
  // out of the deployment. Who signed in, and when, is the audit log's (exported above).
  ...tenantCols(
    "auth_sessions",
    false,
    "a sign-in session: a credential (its id's hash, the provider's sealed tokens, the forgery-check token), short-lived and revocable; sign-ins are the audit log's",
    [
      "id_hash",
      "kind",
      "subject",
      "method",
      "csrf_token",
      "sealed_tokens",
      "token_version",
      "created_at",
      "last_seen_at",
      "revoked_at",
      "revoked_reason",
    ]
  ),
  ...tenantCols(
    "config_pending_approvals",
    true,
    "the tenant's setting changes and decisions",
    [
      "id",
      "config_key",
      "current_value",
      "proposed_value",
      "requested_by",
      "change_comment",
      "impact_summary",
      "status",
      "reviewed_by",
      "review_comment",
      "reviewed_at",
      "expires_at",
      "created_at",
      "scope",
      "action",
      "applied_at",
      "change_shown",
      "review_shown",
    ]
  ),
  ...tenantCols("consent_records", true, "the tenant's proof of its accounts' consents", [
    "id",
    "user_id",
    "consent_type",
    "consent_version",
    "granted",
    "granted_at",
    "revoked_at",
  ]),
  ...tenantCols("consent_records", false, NETWORK, ["ip_address", "user_agent"]),
  ...tenantCols("content_safety_audit", true, "the tenant's moderation decisions", [
    "id",
    "direction",
    "content_type",
    "content_rating_level",
    "user_id",
    "triggered_by",
    "classifier_output",
    "categories_flagged",
    "confidence",
    "severity",
    "action_taken",
    "reasoning",
    "severity_adjustment",
    "context_factors",
    "attribute_to_user",
    "classifier_cost_usd",
    "trajectory_id",
    "agent_id",
    "pipeline_latency_ms",
    "request_id",
    "created_at",
    "reasoning_shown",
    "context_factors_shown",
  ]),
  "content_safety_audit.input_hash": {
    exported: false,
    why: "a keyed hash of the screened text (A-6): it matches only under this deployment's key, and outside it could only be used to test guesses of what someone wrote",
  },
  ...tenantCols("document_embeddings", true, "the tenant's stored documents", [
    "id",
    "chunk_id",
    "document_id",
    "content",
    "chunk_index",
    "start_offset",
    "end_offset",
    "metadata",
    "created_at",
    "updated_at",
    "scope_key",
  ]),
  "document_embeddings.embedding": {
    exported: false,
    why: "a vector this deployment's embedding model derived from content (exported); another deployment derives its own",
  },
  ...tenantCols("effect_ledger", true, "the tenant's external calls and their outcomes", [
    "id",
    "operation_id",
    "effect_key",
    "effect_type",
    "status",
    "request",
    "receipt",
    "error",
    "attempts",
    "created_at",
    "resolved_at",
  ]),
  "effect_ledger.idempotency_key": {
    exported: false,
    why: "the key this deployment hands a downstream to recognise a repeated call; derived from the operation id (exported), and never to be reused by another",
  },
  ...tenantCols("group_invites", true, RECORDS, [
    "id",
    "group_id",
    "inviter_id",
    "invitee_id",
    "status",
    "created_at",
    "resolved_at",
  ]),
  ...tenantCols("group_memberships", true, RECORDS, [
    "id",
    "group_id",
    "user_id",
    "role",
    "joined_at",
    "left_at",
  ]),
  ...tenantCols("groups", true, RECORDS, [
    "id",
    "name",
    "description",
    "metadata",
    "owner_id",
    "status",
    "created_at",
    "updated_at",
  ]),
  ...tenantCols("guest_usage", true, "the tenant's guest usage counts", [
    "translations_used",
    "first_used_at",
    "last_used_at",
  ]),
  "guest_usage.guest_id": {
    exported: false,
    why: "an anonymous visitor's id, held by their device: a handle to their allowance, not the tenant's record",
  },
  ...tenantCols(
    "job_schedule_outcomes",
    true,
    "when the tenant's recurring jobs last ran",
    ["id", "kind", "status", "finished_at"]
  ),
  ...tenantCols(
    "jobs",
    true,
    "the tenant's background work: what ran, when, and how it ended",
    [
      "id",
      "kind",
      "status",
      "attempts",
      "max_attempts",
      "run_at",
      "source",
      "runs_for_suspended",
      "created_at",
      "updated_at",
      "started_at",
      "finished_at",
    ]
  ),
  "jobs.payload": {
    exported: false,
    why: "a job's work item as this deployment's handlers read it (an app's may name accounts): internal, and meaningless elsewhere",
  },
  "jobs.idempotency_key": {
    exported: false,
    why: "this deployment's key against enqueuing a job twice: internal",
  },
  "jobs.locked_until": { exported: false, why: "a worker's lease: internal" },
  "jobs.locked_by": {
    exported: false,
    why: "which of this deployment's instances held a job: internal",
  },
  "jobs.lease_token": {
    exported: false,
    why: "a worker's lease token (a credential for completing the job): internal",
  },
  "jobs.last_error": {
    exported: false,
    why: "the error text a handler raised, for operators: internal detail, never shown to a tenant",
  },
  "job_schedule_outcomes.last_error": {
    exported: false,
    why: "the error text a handler raised, for operators: internal detail, never shown to a tenant",
  },
  ...tenantCols("password_policy", true, "the tenant's password rules", [
    "id",
    "role_id",
    "user_id",
    "rotation_days",
    "min_length",
    "require_uppercase",
    "require_lowercase",
    "require_number",
    "require_special",
    "password_history_count",
    "created_at",
    "updated_at",
  ]),
  ...tenantCols("platform_config_history", true, "the tenant's setting history", [
    "id",
    "config_key",
    "previous_value",
    "new_value",
    "changed_by",
    "change_comment",
    "change_source",
    "created_at",
    "scope",
    "change_shown",
  ]),
  ...tenantCols("proposals", true, "the tenant's held actions and their decisions", [
    "id",
    "operation_id",
    "session_id",
    "trajectory_id",
    "label",
    "status",
    "actor_id",
    "actor_role",
    "effects",
    "effective_risk",
    "payload",
    "observed_version",
    "decided_by",
    "decided_at",
    "decision_note",
    "created_at",
    "updated_at",
    "actor_identity",
    "last_run_error",
    "run_atomic",
    "reminded_at",
    "decision_shown",
  ]),
  "proposals.run_token": {
    exported: false,
    why: "a claimed run's generation token (a lease on running the action): internal",
  },
  ...tenantCols("purge_log", true, "the tenant's record of each erasure that ran", [
    "id",
    "purge_id",
    "user_id",
    "requested_by",
    "reason",
    "status",
    "steps_json",
    "total_deleted",
    "requested_at",
    "completed_at",
    "created_at",
  ]),
  ...tenantCols(
    "rate_limit_events",
    false,
    "a counted request of the last day, keyed by an account or a network address: transient, deleted on a schedule (TASK-215), nothing a tenant keeps",
    ["id", "bucket", "at"]
  ),
  ...tenantCols("review_queue", true, "the tenant's moderation cases", [
    "id",
    "source",
    "priority",
    "status",
    "moderation_result",
    "target_user_id",
    "request_id",
    "explanation_chain",
    "appeal_reason",
    "original_decision_id",
    "claimed_by",
    "claimed_at",
    "resolved_by",
    "resolved_at",
    "decision",
    "reviewer_notes",
    "modified_action",
    "previous_account_status",
    "created_at",
    "updated_at",
    "related_strike_id",
    "notes_shown",
  ]),
  ...tenantCols("tenant_config_overrides", true, "the tenant's own settings", [
    "key",
    "value",
    "updated_by",
    "updated_at",
    "created_at",
  ]),
  ...tenantCols("user_ai_context", true, RECORDS, [
    "user_id",
    "preferences",
    "patterns",
    "updated_at",
  ]),
  ...tenantCols(
    "user_deletions",
    true,
    "the tenant's record of its erasures: whose, when, and how far",
    [
      "user_id",
      "requested_by",
      "soft_deleted_at",
      "purge_after",
      "purged_at",
      "modules",
      "standing",
      "purge_attempts",
      "purge_retry_at",
      "external_erasures",
      "mentions_erased_at",
    ]
  ),
  ...tenantCols(
    "user_deletions",
    false,
    "what an erasure keeps so this deployment can hold a ban or refuse the identity again — a keyed hash of a banned address (it matches only under this deployment's key), the identity provider's subject and pool: never the tenant's record of a person it erased",
    ["email_hash", "email_hash_key", "email_hash_scheme", "cognito_sub", "identity_pool"]
  ),
  "user_deletions.last_purge_error": {
    exported: false,
    why: "the steps a failed purge could not complete, for operators: internal detail",
  },
  ...tenantCols("user_devices", true, RECORDS, [
    "id",
    "user_id",
    "device_name",
    "is_trusted",
    "last_used_at",
    "created_at",
  ]),
  "user_devices.device_id": {
    exported: false,
    why: "a remembered device's key with the identity provider: a sign-in handle, not a record",
  },
  ...tenantCols("user_entitlements", true, RECORDS, [
    "id",
    "user_id",
    "entitlement_group_id",
    "granted_at",
    "expires_at",
    "revoked_at",
    "granted_by",
    "revoked_by",
  ]),
  ...tenantCols("user_feature_restrictions", true, RECORDS, [
    "user_id",
    "feature",
    "reason",
    "created_by",
    "created_at",
  ]),
  ...tenantCols("user_interactions", true, RECORDS, [
    "id",
    "user_id",
    "input",
    "output",
    "feature",
    "rating",
    "created_at",
  ]),
  ...tenantCols("user_strikes", true, RECORDS, [
    "id",
    "user_id",
    "category",
    "severity",
    "moderation_audit_id",
    "trajectory_id",
    "agent_id",
    "reason",
    "expires_at",
    "expired",
    "created_at",
    "guardian_decision_id",
  ]),
  ...tenantCols("users", true, "the tenant's accounts", [
    "id",
    "email",
    "display_name",
    "avatar_url",
    "real_name",
    "role_id",
    "language_preference",
    "timezone",
    "profile_visibility",
    "display_name_visibility",
    "avatar_visibility",
    "language_visibility",
    "timezone_visibility",
    "email_opt_in",
    "push_notifications_enabled",
    "date_of_birth",
    "age_verified",
    "age_verified_at",
    "parental_consent_status",
    "content_rating_level",
    "mfa_enabled",
    "email_verified",
    "created_at",
    "updated_at",
    "last_login_at",
    "deleted_at",
    "account_status",
    "restricted_until",
    "suspended_until",
    "banned_at",
    "ban_reason",
    "status_changed_by",
    "status_changed_at",
    "coppa_enforcement_active",
    "ban_note",
  ]),
  "users.parental_consent_email": {
    exported: true,
    why: "the parent's address the tenant collected as the proof of a child's consent: the tenant's record, which it is accountable for",
  },
  "users.cognito_sub": {
    exported: false,
    why: "this deployment's identity provider's key for the sign-in: another deployment's pool gives every identity a new one (accounts are re-linked by address, TASK-174)",
  },
};

/** The tenant key of every table, never exported (the export's first line names the tenant). */
export const TENANT_KEY_COLUMN: TenantExportColumn = { exported: false, why: TENANT_KEY };

/**
 * A tenant table's exported columns, in the table's register order: the platform's, then the app's
 * own (`appColumns`: platform/tenancy/app-tenant-export.ts, "<table>.<column>" → "exported: …" or
 * "not exported: …"). Undefined when the table has no classified column at all — the export refuses
 * such a table rather than guess.
 */
export function tenantExportColumns(
  table: string,
  appColumns: Readonly<Record<string, string>> = {}
): readonly string[] | undefined {
  const prefix = `${table}.`;
  const platform = Object.entries(TENANT_EXPORT_COLUMNS).filter(([k]) =>
    k.startsWith(prefix)
  );
  const app = Object.entries(appColumns).filter(([k]) => k.startsWith(prefix));
  if (platform.length === 0 && app.length === 0) return undefined;
  return [
    ...platform.filter(([, v]) => v.exported).map(([k]) => k.slice(prefix.length)),
    ...app.filter(([, v]) => /^exported:/.test(v)).map(([k]) => k.slice(prefix.length)),
  ];
}

/**
 * The erasure's statements in other tenants (TASK-193, audit A-3): an operator's act is recorded in
 * the operator's own tenant, and may name an account of another (the "make tenant admin" record).
 * Each runs on the owner connection with the account's id as `$1`, after the account's own
 * tenant's erasure (gdpr-deletion.ts eraseMentionsInOtherTenants, the gdpr.retention-purge job):
 * the free text of a record about the account (its target, or the user_id / userId it names) is
 * erased, and then every mention of its id becomes "erased", in every tenant. The text keys are
 * AUDIT_TEXT_KEYS (built from it: AUDIT_TEXT_ARRAY).
 *
 * Cost (review round 1, item 6): no index serves a match inside details, so each erased account
 * costs one read of the whole audit_log, every tenant's — once per account, by the job, never a
 * request. It is read in page ranges of CROSS_TENANT_ERASURE_PAGES, each its own transaction
 * (`$2`, `$3`: the range's first and past-the-end TIDs), so no transaction is long.
 */
export const CROSS_TENANT_ERASURE: readonly string[] = [
  // The free text of a record about the account (review round 1, item 6) — first, while its id
  // still says which records those are.
  `update audit_log set details = (details - ${AUDIT_TEXT_ARRAY}) || jsonb_build_object('textErased', true) where ctid >= $2::tid and ctid < $3::tid and (target_id = $1::uuid or details->>'user_id' = $1::text or details->>'userId' = $1::text) and details ?| ${AUDIT_TEXT_ARRAY}`,
  // Every mention of its id, in any record.
  "update audit_log set details = regexp_replace(details::text, $1::text, 'erased', 'gi')::jsonb where ctid >= $2::tid and ctid < $3::tid and details::text ~* $1::text",
];

/**
 * The pages of audit_log one CROSS_TENANT_ERASURE pass reads in a transaction (review round 1,
 * item 6): the statements take a page range (`$2`–`$3`, a TID range scan), so each transaction
 * reads at most this many 8 KiB pages (80 MiB) and holds its row locks only that long.
 */
export const CROSS_TENANT_ERASURE_PAGES = 10_000;

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
