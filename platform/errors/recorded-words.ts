/**
 * platform/errors/recorded-words.ts — a record's words, from the catalog (TASK-208, N-110)
 *
 * The platform's notes on a record are stored as a catalog key and values
 * (./recorded-text.ts); these render them in a reader's locale — the subject's data export
 * (platform/auth/data-export.ts) and a held action's decision.
 *
 * @module platform/errors
 */

import { renderShown, shown, type ShownText } from "./shown-text";
import { isRecordedText, type RecordedText } from "./recorded-text";
import { isErrorCode, messageKey, type ErrorCode } from "./registry";
import { CATALOGS, DEFAULT_LOCALE, lookup, renderMessage } from "./messages";

/**
 * A run's recorded note (a proposal's lastRunError: TASK-209) for a screen: an error code's
 * sentence, a `screens.held.note_*` key's — or, recorded before codes, the note as it was.
 */
export function runNoteShown(note: string): ShownText | string {
  if (isErrorCode(note))
    return shown(messageKey(note as ErrorCode) as `errors.${string}`);
  if (/^screens\.held\.note_\w+$/.test(note) && lookup(CATALOGS[DEFAULT_LOCALE], note))
    return shown(note as `screens.${string}`);
  return note;
}

/**
 * A recorded text's words, in `locale`. `note` is the row's own note (a decision's: what the
 * decider wrote, or the system's reason), the message's `note` value unless the record holds
 * one (an erased note: NOTE_ERASED).
 */
export function renderRecorded(
  record: RecordedText,
  locale?: string,
  note?: string
): string {
  if (!isRecordedText(record)) return "";
  return renderShown(
    {
      key: record.key,
      params: { note: note ?? "", ...(record.params as ShownText["params"]) },
    },
    locale
  );
}

/**
 * A held action's decision in words: its record (a withdrawal's), with its note; or the note
 * alone. Undefined when there is neither.
 */
export function decisionWords(
  proposal: { readonly decisionShown?: RecordedText; readonly decisionNote?: string },
  locale?: string
): string | undefined {
  if (proposal.decisionShown && isRecordedText(proposal.decisionShown))
    return renderRecorded(proposal.decisionShown, locale, proposal.decisionNote);
  return proposal.decisionNote;
}

/**
 * A value's platform words in `locale` (TASK-209): a record (a catalog key and values) rendered; a
 * string that is a catalog key of the platform's own notes (`screens.records.*`, a run's
 * `screens.held.note_*`, one with no values) or an error code (an audited act's failure, its
 * message needing no values) rendered; anything else — what a person wrote, a code
 * the catalog does not word — as it is. Objects and lists are walked.
 */
export function renderRecordedDeep(value: unknown, locale: string): unknown {
  if (typeof value === "string") {
    // An error code (an audited act's failure: TASK-209), in its message's words when it needs
    // no values.
    if (isErrorCode(value)) {
      const key = messageKey(value as ErrorCode);
      const words = lookup(CATALOGS[DEFAULT_LOCALE], key);
      return words !== undefined && !words.includes("{")
        ? renderMessage(key, {}, locale)
        : value;
    }
    if (!/^screens\.(?:records|held)\.[a-z_]+$/.test(value)) return value;
    const words = lookup(CATALOGS[DEFAULT_LOCALE], value);
    return words !== undefined && !words.includes("{")
      ? renderMessage(value, {}, locale)
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => renderRecordedDeep(v, locale));
  if (!value || typeof value !== "object") return value;
  if (isRecordedText(value)) return renderRecorded(value, locale);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, renderRecordedDeep(v, locale)])
  );
}
