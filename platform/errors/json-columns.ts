/**
 * platform/errors/json-columns.ts — every jsonb column of the platform's schema, what the most is
 * that any writer stores in it, and what keeps it there (platform TASK-229, ADR-058)
 *
 * Migration 074 bounds every stored JSON value in the database — 128 levels, every number 0 or
 * 1e-18 <= |n| < 1e21, 8 MiB of text as printed (DATABASE_JSON_* in ./json-limits.ts) — for every
 * writer. The application refuses first, with a coded error, so the database's refusal is never
 * what a person meets: each column below names either the call that checks what is written
 * (`checked`: the file and the call — storedJsonViolation through assertStorableJson,
 * assertWithinDatabaseBound, withinDatabaseBound or a writer's own wrapper of it) or, for a column
 * built only from the platform's own bounded fields, what it is built from (`built`). Every
 * writer's maximum is at most 1 MiB of compact JSON, so at most 4 MiB printed, and — for a
 * document an erasure rewrites — at most 7.95 MiB after the soft delete's rewrite at the worst
 * shape found (docs/JSON_BOUND.md §1; pinned by __tests__/db/json-bound.db.test.ts): within the
 * database's bound. An effect's receipt is the exception: up
 * to 6 MiB printed (EFFECT_RECEIPT_MAX_TEXT), and no erasure rewrites the effect ledger.
 *
 * Every file whose SQL writes a column is named in its row: the `checked` writers, the files
 * that build a `built` column (`files`), and any other (`otherWriters`, each with why it needs
 * no check of its own — an erasure's rewrite adds no value; the bound itself tests the result).
 *
 * `__tests__/db/json-columns.db.test.ts` (@guard) compares this register — with the consuming
 * app's own columns, platform/auth/app-json-columns.ts — with the database's catalogue and with
 * the source: a jsonb column not listed here fails CI; so does a file under platform/, lib/,
 * app/, components/ or scripts/ whose SQL text inserts into or updates a listed column and is not
 * named in that column's row; so does a `checked` file that no longer calls its check (a call
 * in the code — a mention in a comment does not count). What the guard reads is SQL written as
 * string or template literals in those files: a column written only through a SQL function
 * (platform_config's values, by set_config_with_history) is covered by its `checked` row and by
 * the database's bound, not by the scan.
 *
 * @module platform/errors
 */

/** How a column is kept within the bound. */
export type JsonColumnKeeper =
  /** A writer checks every value it writes, with this call, in this file (from the repo root). */
  | { readonly checked: readonly { readonly file: string; readonly call: string }[] }
  /** Built only from the platform's own bounded fields: what it is built from, and where. */
  | { readonly built: string; readonly files?: readonly string[] };

/** Another file whose SQL writes a column, and why it needs no check of its own. */
export interface OtherJsonWriter {
  readonly file: string;
  readonly why: string;
}

/** One jsonb column: `table.column`, the most any writer stores, and what keeps it there. */
export interface JsonColumn {
  readonly column: string;
  /** The legitimate maximum, in words (the most any writer in the code writes). */
  readonly max: string;
  readonly keeper: JsonColumnKeeper;
  /** Every other file whose SQL writes this column (code review B-8). */
  readonly otherWriters?: readonly OtherJsonWriter[];
}

/** Every file a row names as writing its column (from the repository root). */
export function namedWriters(column: JsonColumn): string[] {
  return [
    ...("checked" in column.keeper
      ? column.keeper.checked.map((w) => w.file)
      : (column.keeper.files ?? [])),
    ...(column.otherWriters ?? []).map((w) => w.file),
  ];
}

const STATE = "platform/app-framework/postgres-state-store.ts";
const PROPOSALS = "platform/agents/postgres-proposal-store.ts";
const TRAJECTORIES = "platform/agents/postgres-trajectory-store.ts";
const LEDGER = "platform/agents/postgres-effect-ledger.ts";
const CONFIG = "platform/auth/platform-config.ts";
const MODERATION = "platform/moderation/store.ts";
const REVIEWS = "platform/moderation/review-store.ts";

const USER_DATA = "platform/auth/user-data.ts";
const GDPR = "platform/auth/gdpr-deletion.ts";
const HOLDS = "platform/admin/hold-expiry.ts";
const CONFIG_APPROVAL = "platform/admin/config-approval.ts";

/** A column a writer checks with `call` in `file` (more than one writer: listed in turn). */
const checked = (
  column: string,
  max: string,
  ...writers: [file: string, call: string][]
): JsonColumn => ({
  column,
  max,
  keeper: { checked: writers.map(([file, call]) => ({ file, call })) },
});

/** A column built only from the platform's own bounded fields, in `files`. */
const built = (
  column: string,
  max: string,
  from: string,
  ...files: string[]
): JsonColumn => ({
  column,
  max,
  keeper: { built: from, files },
});

/** `column` with the other files whose SQL writes it. */
const also = (
  column: JsonColumn,
  ...others: [file: string, why: string][]
): JsonColumn => ({
  ...column,
  otherWriters: others.map(([file, why]) => ({ file, why })),
});

/** Why an erasure's statement needs no check of its own. */
const ERASURE =
  "an erasure's rewrite or removal of what is already stored (jsonb_erase_id_text, jsonb_erase_address_text, a member or the value removed): it adds no value of its own, and the database's bound tests the result";
/** Why a statement that builds the value in SQL needs none. */
const OWN_FIELDS =
  "builds the value in SQL from the platform's own columns and fixed words (jsonb_build_object)";

/** The config validator: 64 KiB of JSON and storedJsonViolation (nesting and the number range). */
const CONFIG_VALUE = "64 KiB (MAX_CONFIG_VALUE_BYTES)";

/** Every jsonb column of the platform's schema (PF: 21 tables, 42 columns), by table and column. */
export const PLATFORM_JSON_COLUMNS: readonly JsonColumn[] = [
  checked("agent_approval_policy.rules", "small (validated approval rules)", [
    "platform/agents/postgres-approval-policy-store.ts",
    "assertWithinDatabaseBound",
  ]),
  also(
    checked(
      "agent_trajectories.steps",
      "16 MiB compact per run (1 000 steps of at most 1 MiB); bounded in depth only by the database until migration 076",
      [TRAJECTORIES, "assertStorableJson"],
      ["platform/agents/runtime.ts", "storedJsonViolation"]
    ),
    [USER_DATA, ERASURE],
    [GDPR, ERASURE]
  ),
  built(
    "agent_trajectories.total_cost",
    "a cost object (< 1 KB)",
    "the costs the trajectory store adds up from its steps (numbers it computes)",
    TRAJECTORIES
  ),
  checked("ai_metrics.tags", "small (a metric's tags)", [
    "platform/observability/metrics-sink.ts",
    "withinDatabaseBound",
  ]),
  checked("ai_metrics.values", "small (a metric's values)", [
    "platform/observability/metrics-sink.ts",
    "withinDatabaseBound",
  ]),
  // The session's metadata holds the caller's participants and budget (code review B-7: it was
  // registered as "built from the platform's own fields" and written unchecked).
  also(
    checked(
      "app_sessions.meta",
      "small (the participants, the budget's three numbers, the turn state)",
      [STATE, "assertWithinDatabaseBound"]
    ),
    [USER_DATA, ERASURE]
  ),
  also(
    checked("app_sessions.state", "1 MiB compact (STORED_JSON_MAX_BYTES)", [
      STATE,
      "assertStorableJson",
    ]),
    [USER_DATA, ERASURE],
    [GDPR, ERASURE]
  ),
  also(
    checked(
      "audit_log.details",
      "1 MiB compact",
      ["platform/auth/audit.ts", "assertStorableJson"],
      ["platform/auth/identity-relink.ts", "assertStorableJson"]
    ),
    [HOLDS, OWN_FIELDS],
    [CONFIG_APPROVAL, OWN_FIELDS],
    [GDPR, `${OWN_FIELDS}; and ${ERASURE}`],
    [USER_DATA, ERASURE]
  ),
  built(
    "config_pending_approvals.change_shown",
    "small (a catalog key and values)",
    "the config approval's own words: catalog keys and the setting's checked values",
    CONFIG_APPROVAL
  ),
  checked(
    "config_pending_approvals.current_value",
    CONFIG_VALUE,
    [CONFIG_APPROVAL, "assertWithinDatabaseBound"],
    [CONFIG, "storedJsonViolation"]
  ),
  checked(
    "config_pending_approvals.proposed_value",
    CONFIG_VALUE,
    [CONFIG_APPROVAL, "assertWithinDatabaseBound"],
    [CONFIG, "storedJsonViolation"]
  ),
  built(
    "config_pending_approvals.review_shown",
    "small (a catalog key and values)",
    "the config approval's own words: catalog keys and the reviewer's checked note",
    CONFIG_APPROVAL
  ),
  also(
    checked(
      "content_safety_audit.classifier_output",
      "1 MiB compact (else the not-kept marker)",
      [MODERATION, "storedClassifierJson"]
    ),
    [USER_DATA, ERASURE]
  ),
  built(
    "content_safety_audit.context_factors_shown",
    "small (catalog keys and values)",
    "the moderation pipeline's recorded factors (platform/moderation/reasons.ts)",
    MODERATION
  ),
  built(
    "content_safety_audit.reasoning_shown",
    "small (catalog keys and values)",
    "the moderation pipeline's recorded reasons (platform/moderation/reasons.ts)",
    MODERATION
  ),
  checked("document_embeddings.metadata", "1 MiB compact", [
    "platform/rag/postgres-embedding-store.ts",
    "assertWithinDatabaseBound",
  ]),
  checked(
    "effect_ledger.receipt",
    "6 MiB as the database prints it (EFFECT_RECEIPT_MAX_TEXT: an image of about 4.4 MiB as base64; else the not-kept marker); no erasure rewrites it",
    [LEDGER, "receiptToStore"]
  ),
  checked("effect_ledger.request", "1 MiB compact", [
    LEDGER,
    "assertWithinDatabaseBound",
  ]),
  checked("groups.metadata", "small (a group's metadata)", [
    "platform/social/postgres-social-store.ts",
    "assertWithinDatabaseBound",
  ]),
  checked("jobs.payload", "1 MiB compact", [
    "platform/jobs/postgres-store.ts",
    "assertWithinDatabaseBound",
  ]),
  checked("platform_config.allowed_values", CONFIG_VALUE, [
    CONFIG,
    "storedJsonViolation",
  ]),
  checked("platform_config.default_value", CONFIG_VALUE, [CONFIG, "storedJsonViolation"]),
  checked("platform_config.max_value", CONFIG_VALUE, [CONFIG, "storedJsonViolation"]),
  checked("platform_config.min_value", CONFIG_VALUE, [CONFIG, "storedJsonViolation"]),
  checked("platform_config.value", CONFIG_VALUE, [CONFIG, "storedJsonViolation"]),
  built(
    "platform_config_history.change_shown",
    "small (a catalog key and values)",
    "the config change's own words: catalog keys and the setting's checked values",
    CONFIG
  ),
  checked("platform_config_history.new_value", CONFIG_VALUE, [
    CONFIG,
    "storedJsonViolation",
  ]),
  checked("platform_config_history.previous_value", CONFIG_VALUE, [
    CONFIG,
    "storedJsonViolation",
  ]),
  also(
    built(
      "proposals.actor_identity",
      "a small object (an actor's type, id and role)",
      "the proposal store's AgentIdentity of the proposer",
      PROPOSALS
    ),
    [USER_DATA, ERASURE]
  ),
  also(
    built(
      "proposals.decision_shown",
      "small (a catalog key and values)",
      "the decision's recorded words (platform/errors/recorded-text.ts)",
      PROPOSALS,
      HOLDS
    ),
    [USER_DATA, ERASURE]
  ),
  also(
    built(
      "proposals.effects",
      "small (the effects an action spec declares)",
      "the action spec's declared effects",
      PROPOSALS
    ),
    [USER_DATA, ERASURE],
    [GDPR, ERASURE]
  ),
  also(
    checked("proposals.payload", "1 MiB compact", [PROPOSALS, "assertStorableJson"]),
    [USER_DATA, ERASURE],
    [GDPR, ERASURE]
  ),
  built(
    "purge_log.steps_json",
    "small (one entry per erasure step)",
    "the purge pipeline's steps: names, tables and row counts (platform/gdpr/hard-purge.ts)",
    "platform/gdpr/account-erasure.ts"
  ),
  also(
    checked(
      "review_queue.explanation_chain",
      "1 MiB compact (else the not-kept marker)",
      [REVIEWS, "storedClassifierJson"]
    ),
    [USER_DATA, ERASURE],
    [GDPR, ERASURE]
  ),
  also(
    checked(
      "review_queue.moderation_result",
      "the classifier output (1 MiB) and the decision's own fields, always kept (a field over the limits is named in fieldsNotKept)",
      [REVIEWS, "storableModerationResult"]
    ),
    [USER_DATA, ERASURE],
    [GDPR, ERASURE]
  ),
  built(
    "review_queue.notes_shown",
    "small (a recorded note)",
    "the reviewer's checked note as recorded text (platform/errors/recorded-text.ts)",
    REVIEWS
  ),
  built(
    "roles.description_note",
    "small (a sentence)",
    "an admin's checked note as recorded text (platform/errors/recorded-text.ts)",
    "app/api/admin/ai/handlers/roles.ts"
  ),
  checked("tenant_config_overrides.value", CONFIG_VALUE, [CONFIG, "storedJsonViolation"]),
  also(
    built(
      "user_ai_context.preferences",
      "no application writer: written only by the erasure's rewrite (jsonb_erase_id_text)",
      "nothing the application writes; the erasure only replaces an id in it"
    ),
    [USER_DATA, ERASURE]
  ),
  built(
    "user_deletions.external_erasures",
    "small (one entry per external store)",
    "the erasure's record of each external store's outcome (platform/gdpr/external-erasure.ts)",
    GDPR,
    "platform/gdpr/erasure-attestation.ts"
  ),
  built(
    "user_deletions.modules",
    "small (module names)",
    "the names of the registered deletion modules (platform/auth/gdpr-deletion.ts)",
    GDPR
  ),
  also(
    built(
      "users.ban_note",
      "small (a sentence)",
      "an admin's checked ban note as recorded text (platform/errors/recorded-text.ts)",
      "platform/auth/email-verification.ts",
      "platform/auth/user-provisioning.ts",
      "platform/moderation/sentinel.ts"
    ),
    ["platform/moderation/review-service.ts", "sets it to null (a ban lifted)"],
    [GDPR, ERASURE]
  ),
];
