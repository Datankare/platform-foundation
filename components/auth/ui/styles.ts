/**
 * components/auth/ui/styles.ts — the sign-in screens' one set of control shapes (TASK-222)
 *
 * The sign-in, account, reset, two-step and verification steps each wrote the same class lists
 * by hand. These are the one set, named by what a thing is. Every text colour here meets 4.5:1
 * on the card (#111827) and the field (#0a0f1e) — WCAG 2.2 AA 1.4.3; a placeholder is gray-400,
 * not gray-500 — and every control shows a visible focus ring (2.4.7).
 *
 * Class lists only: no words for a person (those are the catalogue's).
 *
 * @module components/auth/ui
 */

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";

/** A text field: an address, a password, a date. Red border while its value is refused. */
export const AUTH_INPUT =
  "w-full min-w-0 bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50 aria-[invalid=true]:border-red-500";

/** A six-digit code field. */
export const AUTH_CODE_INPUT =
  "w-full min-w-0 bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-4 text-white placeholder-gray-400 text-2xl text-center tracking-[0.5em] font-mono placeholder:text-base placeholder:tracking-normal placeholder:font-sans focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-50 aria-[invalid=true]:border-red-500";

/** The step's one main action. */
export const AUTH_PRIMARY = `w-full bg-blue-700 hover:bg-blue-800 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS}`;

/** A quieter whole-width action (continue as a guest). */
export const AUTH_SECONDARY = `w-full border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS}`;

/** A text button that moves between steps (create one, back to sign in, send a new code). */
export const AUTH_LINK = `text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline transition rounded disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed ${FOCUS}`;

/** A heading that takes focus when its step opens: the ring is visible. */
export const AUTH_HEADING = `text-xl font-bold text-white text-center rounded ${FOCUS}`;

/** A line under the heading that says what the step is for. */
export const AUTH_LEAD = "text-sm text-gray-300 text-center";

/** A field's label. */
export const AUTH_LABEL = "text-sm text-gray-300";

/** A field's help line. */
export const AUTH_HELP = "text-xs text-gray-400";

/** A refusal, said beside the form. */
export const AUTH_ERROR =
  "bg-red-900/30 border border-red-700 text-red-200 rounded-xl px-4 py-3 text-sm";

/** A notice: a code sent, an address verified. */
export const AUTH_NOTICE =
  "bg-gray-800/40 border border-gray-700 text-gray-200 rounded-xl px-4 py-3 text-sm";
