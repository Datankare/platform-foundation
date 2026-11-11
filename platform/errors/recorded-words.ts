/**
 * platform/errors/recorded-words.ts — a record's words, from the catalog (TASK-208, N-110)
 *
 * The platform's notes on a record are stored as a catalog key and values
 * (./recorded-text.ts); these render them in a reader's locale — the subject's data export
 * (platform/auth/data-export.ts) and a held action's decision.
 *
 * @module platform/errors
 */

import { renderShown, type ShownText } from "./shown-text";
import { isRecordedText, type RecordedText } from "./recorded-text";

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
