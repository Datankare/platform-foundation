/**
 * components/admin/ui/tokens.ts — the admin console's one set of colours and control shapes
 * (TASK-216, SCREEN-FINDINGS P12)
 *
 * The console's screens each wrote their own class lists, and a review found four themes among
 * them (fixed dark, a white bar, light boxes on dark, the device's own setting). These are the
 * one set: the dark palette the console already had, named by what a thing is — never by a
 * colour — so a screen says `TONE.held`, not "amber". Every pair here meets 4.5:1 for text
 * (WCAG 2.2 AA, 1.4.3): gray-500 on the panel colour does not, so the quietest text is gray-400.
 *
 * Class lists only: no words for a person (those are the catalogue's).
 *
 * @module components/admin/ui
 */

/** Surfaces, from the page outwards. */
export const SURFACE = {
  page: "bg-[#0a0f1e]",
  panel: "rounded-xl border border-gray-800 bg-[#111827]",
  inset: "rounded-lg border border-gray-800 bg-[#0a0f1e]",
} as const;

/** Text, from the loudest to the quietest (the quietest still 4.5:1 on a panel). */
export const TEXT = {
  strong: "text-white",
  body: "text-gray-200",
  quiet: "text-gray-300",
  faint: "text-gray-400",
} as const;

/** What an outcome or a notice is: one colour each, with its border and its text. */
export const TONE = {
  applied: "border-green-700 bg-green-900/20 text-green-100",
  held: "border-blue-700 bg-blue-900/20 text-blue-100",
  unrecorded: "border-amber-700 bg-amber-900/20 text-amber-100",
  refused: "border-red-700 bg-red-950/40 text-red-100",
  info: "border-gray-700 bg-gray-800/40 text-gray-200",
} as const;
export type Tone = keyof typeof TONE;

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";

/** Buttons: one primary, one quiet, one for an action that cannot be undone, one link. */
export const BUTTON = {
  primary: `rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-800 disabled:opacity-60 ${FOCUS}`,
  quiet: `rounded border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-60 ${FOCUS}`,
  danger: `rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-600 disabled:opacity-60 ${FOCUS}`,
  link: `text-left text-blue-300 underline-offset-2 hover:underline ${FOCUS}`,
} as const;

/** A text input, a select or a text area. */
export const CONTROL = `w-full min-w-0 rounded-lg border border-gray-600 bg-[#0a0f1e] px-3 py-2 text-sm text-white disabled:opacity-60 aria-[invalid=true]:border-red-500 ${FOCUS}`;

/** A heading that takes focus when its panel opens: the ring is visible (2.4.7). */
export const FOCUS_TARGET = `${FOCUS} rounded`;

export const FOCUS_RING = FOCUS;
