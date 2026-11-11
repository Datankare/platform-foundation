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
 * platform/ and lib/ — its known list is empty.
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
  kind: "approved" | "undecided" = "approved"
): ShownText {
  return {
    key: kind === "approved" ? WITHDRAWN_AFTER_APPROVAL : WITHDRAWN_UNDECIDED,
    params: {
      approvedBy: approved.decidedBy ?? RECORDED_UNKNOWN,
      approvedAt: approved.decidedAt ?? RECORDED_UNKNOWN,
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
