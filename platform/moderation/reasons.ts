/**
 * platform/moderation/reasons.ts — why the moderation pipeline decided, as catalog keys and values
 * (TASK-209)
 *
 * The Guardian's reasoning, its context factors, a content-rating level's name, the classifier's
 * own notes, the modality screen's reasons and the RAG screen's were English composed in
 * TypeScript, stored (content_safety_audit, a review case's moderation result) and shown — to a
 * moderator on the review dashboard, to a user in their data export and an appeal. Each is now a
 * catalog key and values (`screens.moderation.*`, messages/en.json), worded where it is read, in
 * the reader's language; the catalog carries the words they had, so what a moderator or a user
 * reads is unchanged (__tests__/moderation-reasons.test.ts compares every template's words with
 * the English it replaced).
 *
 * A reason recorded before the keys, which migration 067 could not match to a template exactly,
 * stays as it was stored: shown as "a reason recorded before reasons were coded", its stored text
 * behind a disclosure (as a job's uncoded failure, TASK-207 N-108). The classifier model's own
 * words are kept apart, as `rawReason`, and no screen shows them.
 *
 * The review assistant's prompt is model input, not screen text: it renders these in English at
 * that boundary (platform/moderation/review-assist.ts), as the prompt always read them.
 *
 * @module platform/moderation
 */

import {
  isShownText,
  renderShown,
  shown,
  type ShownText,
} from "@/platform/errors/shown-text";

/** A decision's reasons, one per line, as the pipeline records them. */
export type Reasons = readonly ShownText[];

/** Reasons as a record holds them: the keys, or — recorded before them — the stored text. */
export type RecordedReasons = Reasons | string;

/** A context factor as a record holds it: a key and values, or — recorded before — its text. */
export type RecordedFactor = ShownText | string;

/**
 * Between the items of a list of messages inside one reason — a context line's factors, an
 * unreadable answer's problems — each its own clause, joined as the pipeline always joined them
 * (a list of values is the locale's conjunction; these are messages, not values).
 */
const LIST_SEPARATOR = "; ";

/** One reason's words in `locale`: a list of messages in it rendered and joined (LIST_SEPARATOR). */
export function reasonText(reason: ShownText, locale?: string): string {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(reason.params ?? {}))
    params[k] =
      Array.isArray(v) && v.length > 0 && v.every(isShownText)
        ? v.map((x) => reasonText(x, locale)).join(LIST_SEPARATOR)
        : isShownText(v)
          ? reasonText(v, locale)
          : v;
  return renderShown({ key: reason.key, params } as ShownText, locale);
}

/** Reasons' words, one after another, as the pipeline joined them. */
export function reasonsText(reasons: Reasons, locale?: string): string {
  return reasons.map((r) => reasonText(r, locale)).join(" ");
}

/**
 * Recorded reasons for a reader: the words, or — recorded before the keys — the catalog's note
 * that they predate them, with the stored text for a disclosure (never the screen's words).
 */
export function recordedReasons(
  recorded: RecordedReasons | undefined,
  locale?: string
): { readonly text: string; readonly stored?: string } {
  if (recorded === undefined) return { text: "" };
  if (typeof recorded !== "string") return { text: reasonsText(recorded, locale) };
  if (recorded === "") return { text: "" };
  return {
    text: renderShown(shown("screens.moderation.legacy.recorded"), locale),
    stored: recorded,
  };
}

/** A recorded context factor for a reader, as recordedReasons. */
export function recordedFactor(
  factor: RecordedFactor,
  locale?: string
): { readonly text: string; readonly stored?: string } {
  return typeof factor === "string"
    ? {
        text: renderShown(shown("screens.moderation.legacy.recorded"), locale),
        stored: factor,
      }
    : { text: reasonText(factor, locale) };
}

/** Is `value` recorded reasons (a list of keys, or a stored text)? */
export function isRecordedReasons(value: unknown): value is RecordedReasons {
  return typeof value === "string" || (Array.isArray(value) && value.every(isShownText));
}

/** Is `value` a recorded context factor (a key and values, or a stored text)? */
export function isRecordedFactor(value: unknown): value is RecordedFactor {
  return typeof value === "string" || isShownText(value);
}
