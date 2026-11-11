/**
 * platform/errors/recorded-text.ts — words the platform records about a decision, a run or an
 * account, as a catalog key and its values (TASK-208, N-110; ADR-051 D4)
 *
 * The platform's own notes on a record used to be English that SQL wrote into the row: a
 * withdrawn approval's "Approved by … at …, never run; withdrawn: …", an abandoned run's "no
 * activity and no open hold since …", the note left where an erased one was, a ban carried over
 * to a new account, who acted in a subject's audit export ("the platform", "another account").
 * Every reader saw them in English, whatever its locale. Now the row keeps the message's key and
 * values (a ShownText: platform/errors/shown-text.ts) — migration 066 moved the rows written
 * before — and whatever shows them (the subject's data export, platform/auth/data-export.ts)
 * renders them from the catalog (`screens.records.*`), in the reader's locale. What a person
 * wrote (a decider's note, a moderator's reason) stays theirs, as written: it is a value here.
 *
 * __tests__/screen-text-indirect (rule C, SQL) fails on words SQL writes anywhere in app/api,
 * platform/ and lib/ — its known list is empty; rule F (TASK-209, N-112) on words TypeScript
 * writes into a record's note, reason, comment or error.
 *
 * @module platform/errors
 */

// Types only: the stores that write records (provisioning, the proposal stores) load this from
// the operator's scripts too (scripts/relink-identity.mjs), which do not load the catalog; the
// words are rendered by ./recorded-words.ts.
import type { ShownText } from "./shown-text";

/** What is not recorded (who had approved a hold, and when, on an old row). */
export const RECORDED_UNKNOWN: ShownText = { key: "screens.records.unknown" };

/** The note left in place of one erased with the account it was about. */
export const NOTE_ERASED: ShownText = { key: "screens.records.note_erased" };

/** Why an account starts banned: a ban on its address carried over (A-11). */
export const BAN_CARRIED_OVER: ShownText = { key: "screens.records.ban_carried_over" };

/** The record a withdrawn approval keeps; its note (why it was withdrawn) is the row's own. */
export const WITHDRAWN_AFTER_APPROVAL = "screens.records.withdrawn_after_approval";
/** The record an undecided run withdrawn without running keeps (TASK-194 round 5). */
export const WITHDRAWN_UNDECIDED = "screens.records.withdrawn_undecided";
/** A decision's note alone — what is shown when only the note is recorded (an erased one). */
export const NOTE_ONLY = "screens.records.note";

// ── The platform's own notes (TASK-209, N-112) ─────────────────────────────────────────────
// What the platform says on a record — why a hold lapsed, was withdrawn or superseded, how a
// person's decision ended when they wrote no note, why a run's approval was kept, why an account
// was banned — is one of these, a key and values; what a person wrote stays a string, as written.
// __tests__/screen-text-indirect rule F fails on words TypeScript writes into a record's note.

/** An approval never used, withdrawn when its period ran out (hold-expiry). */
export const expiredUnused = (days: number): ShownText => ({
  key: "screens.records.expired_unused",
  params: { days },
});
/** A hold never decided, rejected when its period ran out (TASK-193). */
export const expiredUndecided = (days: number): ShownText => ({
  key: "screens.records.expired_undecided",
  params: { days },
});
/** An approval whose run failed, withdrawn by a person who wrote no note. */
export const WITHDRAWN_RUN_FAILED: ShownText = {
  key: "screens.records.withdrawn_run_failed",
};
/** An undecided run a person verified did not take effect, and withdrew (no note written). */
export const VERIFIED_NOT_APPLIED: ShownText = {
  key: "screens.records.verified_not_applied",
};
/** An undecided run a person verified took effect (no note written). */
export const VERIFIED_APPLIED: ShownText = { key: "screens.records.verified_applied" };
/** An undecided run a person verified did not take effect, and approved again (no note). */
export const APPROVED_AGAIN: ShownText = { key: "screens.records.approved_again" };
/** A proposal revised: the one it replaces is superseded (ADR-031 D6), unless a reason is given. */
export const REVISED: ShownText = { key: "screens.records.revised" };
/** An approval superseded because the state it was made against moved (ADR-031 D5). */
export const staleState = (observed: number, current: number): ShownText => ({
  key: "screens.records.stale_state",
  params: { observed, current },
});
/** A hold rejected as a duplicate of another, older one that stands (TASK-199). */
export const duplicateOf = (holdId: string): ShownText => ({
  key: "screens.records.duplicate_of",
  params: { holdId },
});
/** A held change withdrawn because what it would replace changed (round 21, I-2). */
export const REFUSED_STALE: ShownText = { key: "screens.records.refused_stale" };
/** A held change withdrawn because it is refused for good: why (a code's sentence, a rule). */
export const refused = (reason: ShownText): ShownText => ({
  key: "screens.records.refused",
  params: { reason },
});
/** A change to a required job's enabled key, refused for good (round 20, nit 2). */
export const requiredJob = (key: string): ShownText => ({
  key: "screens.records.required_job",
  params: { key },
});
/** Holds on a key withdrawn because the key was reduced: `reason` says how (review 12 H2). */
export const superseded = (reason: ShownText): ShownText => ({
  key: "screens.records.superseded",
  params: { reason },
});
/** A power reduction applied unheld to a key (superseded's reason). */
export const POWER_REDUCED: ShownText = { key: "screens.records.power_reduced" };
/** Every agent suspended by an operator, who said why (superseded's reason). */
export const agentsSuspended = (reason: string): ShownText => ({
  key: "screens.records.agents_suspended",
  params: { reason },
});
/** A two-person approval withdrawn by the system when its apply was refused (config-approval). */
export const configWithdrawn = (
  why: ShownText,
  approved: { readonly by?: string | null; readonly at?: string | null }
): ShownText => ({
  key: "screens.records.config_withdrawn",
  params: {
    why,
    approvedBy: approved.by ?? RECORDED_UNKNOWN,
    approvedAt: approved.at ?? RECORDED_UNKNOWN,
  },
});
/** A setting changed on the config page with no comment written. */
export const CHANGED_ON_PAGE: ShownText = { key: "screens.records.changed_on_page" };
/** A tenant's setting changed by an operator, with no comment written. */
export const SET_BY_OPERATOR: ShownText = { key: "screens.records.set_by_operator" };
/** A setting's own value removed, to use the platform default, with no comment written. */
export const RESET_TO_DEFAULT: ShownText = { key: "screens.records.reset_to_default" };
/** A two-person approval applied: the requester's comment, as written (or the platform's note). */
export const changeApproved = (comment: string | ShownText): ShownText => ({
  key: "screens.records.change_approved",
  params: { note: comment },
});
/** What an applied approval's record names as the change's note: the request's own (TASK-209). */
export function approvedNote(record: {
  readonly changeComment: string;
  readonly changeShown?: { readonly key: string; readonly params?: unknown };
}): string | ShownText {
  const c = record.changeShown;
  return c && typeof c.key === "string" && c.key.startsWith("screens.")
    ? (c as ShownText)
    : record.changeComment;
}

/** Every agent suspended at once (the kill switch): the operator's reason, as written. */
export const emergencySuspended = (reason: string): ShownText => ({
  key: "screens.records.emergency_suspended",
  params: { reason },
});
/** An account banned by the Sentinel: its strikes passed the ban threshold. */
export const BAN_STRIKE_THRESHOLD: ShownText = {
  key: "screens.records.ban_strike_threshold",
};
/**
 * A Sentinel strike's stored reason is `guardian_block:<what triggered the block>` (a code: its
 * category and severity are their own columns) — worded on export as strikeReasonText says.
 */
export const STRIKE_REASON_KIND = "guardian_block";

/** A strike's words, from its code and its row's category and severity; undefined if not one. */
export function strikeReasonText(
  reason: unknown,
  row: { readonly category?: unknown; readonly severity?: unknown }
): ShownText | undefined {
  if (typeof reason !== "string") return undefined;
  const m = /^guardian_block:([a-z][a-z-]*)$/.exec(reason);
  if (!m) return undefined;
  return {
    key: "screens.records.strike_guardian_block",
    params: {
      category: String(row.category ?? ""),
      severity: String(row.severity ?? ""),
      triggeredBy: m[1],
    },
  };
}

/** An escalation no person reviewed within its SLA, blocked by the reaper (ADR-041). */
export const escalationAutoBlocked = (hours: number): ShownText => ({
  key: "screens.records.escalation_auto_blocked",
  params: { hours },
});
/** An undecided run a person marked executed: who, and their note (or VERIFIED_APPLIED). */
export const markedExecuted = (by: string, note: string | ShownText): ShownText => ({
  key: "screens.records.marked_executed",
  params: { by, note },
});

/**
 * A decision's note as given: what a person wrote (a string, as written), or the platform's own
 * (a catalog key and values) — never English the platform composed (TASK-209).
 */
export type RecordedNote = string | ShownText;

/** A note's two columns: the text a person wrote, and the platform's key and values. */
export function noteColumns(note: RecordedNote | undefined): {
  readonly text: string | null;
  readonly shown: ShownText | null;
} {
  if (note === undefined) return { text: null, shown: null };
  return typeof note === "string"
    ? { text: note, shown: null }
    : { text: null, shown: note };
}

/** A record's words as stored: a message's key and values (checked before it is rendered). */
export interface RecordedText {
  readonly key: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * The record a withdrawn approval keeps (ProposalStore.withdraw, supersede and
 * resolveIndeterminate): who had approved it and when — unknown when not recorded. The SQL
 * stores build the same object inline, from the same keys (a query's text is never built from
 * values: data-sql-hygiene).
 */
export function withdrawalRecord(
  approved: { readonly decidedBy?: string; readonly decidedAt?: string },
  kind: "approved" | "undecided" = "approved",
  /** The platform's own why (TASK-209): kept in the record; a person's stays the row's note. */
  why?: ShownText
): ShownText {
  return {
    key: kind === "approved" ? WITHDRAWN_AFTER_APPROVAL : WITHDRAWN_UNDECIDED,
    params: {
      approvedBy: approved.decidedBy ?? RECORDED_UNKNOWN,
      approvedAt: approved.decidedAt ?? RECORDED_UNKNOWN,
      ...(why ? { note: why } : {}),
    },
  };
}

/** An abandoned run's recorded reason (the trajectory-retention reaper): idle since `since`. */
export function abandonedReason(since: string): ShownText {
  return { key: "screens.records.trajectory_abandoned", params: { since } };
}

/** Who acted, in a subject's audit export, as the export's SQL records it: a code. */
export const EXPORT_ACTOR_KEYS: Readonly<Record<string, ShownText>> = {
  platform: { key: "screens.records.by_platform" },
  another_account: { key: "screens.records.by_another_account" },
};

/** A stored value that is a record's words: a screen message's key, and values if any. */
export function isRecordedText(value: unknown): value is ShownText {
  if (!value || typeof value !== "object") return false;
  const v = value as { key?: unknown; params?: unknown };
  return (
    typeof v.key === "string" &&
    v.key.startsWith("screens.") &&
    (v.params === undefined || (typeof v.params === "object" && v.params !== null))
  );
}
