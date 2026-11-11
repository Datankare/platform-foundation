/**
 * platform/errors/shown-text.ts — text an API answer gives a screen to show, as a catalog key and
 * its values (TASK-206, N-102; ADR-051 D4)
 *
 * A route's answer that a screen shows as words — a command-bar action's result, why a hold
 * waits, a readiness check's detail — carries the message's key and its values, never English the
 * server wrote. The screen renders it with renderShown (the catalog, in the viewer's locale, as
 * every screen literal since TASK-205). The key is a screen message (`screens.…`), so a route
 * cannot hand a screen an error code's sentence or a free string; __tests__/screen-text-indirect
 * (rule C) fails on English written in app/api, and on a key English does not have.
 *
 * @module platform/errors
 */

import { renderMessage, type MessageValues } from "./messages";

/**
 * A message's key: a screen's (`screens.…`, in messages/en.json or an app's messages/app), or an
 * error code's sentence (`errors.…`, messageKey) when what is shown is a recorded refusal.
 */
export type ShownKey = `screens.${string}` | `errors.${string}`;

/** A message's values: text, numbers, lists — or another screen message, rendered first. */
export type ShownParams = Readonly<
  Record<string, string | number | readonly string[] | ShownText | readonly ShownText[]>
>;

/** Words for a screen, as the catalog's key and the values it takes. */
export interface ShownText {
  readonly key: ShownKey;
  readonly params?: ShownParams;
}

/** A ShownText for `key` with `params` (none when empty). */
export function shown(key: ShownKey, params?: ShownParams): ShownText {
  return params && Object.keys(params).length > 0 ? { key, params } : { key };
}

/** Whether a value read from an answer is a ShownText (a screen message's key, its values). */
export function isShownText(value: unknown): value is ShownText {
  if (!value || typeof value !== "object") return false;
  const v = value as { key?: unknown; params?: unknown };
  return (
    typeof v.key === "string" &&
    (v.key.startsWith("screens.") || v.key.startsWith("errors.")) &&
    (v.params === undefined || (typeof v.params === "object" && v.params !== null))
  );
}

/** The words of a ShownText, from the catalog (a value that is itself one, rendered first). */
export function renderShown(text: ShownText, locale?: string): string {
  const values: Record<string, string | number | readonly string[]> = {};
  for (const [name, value] of Object.entries(text.params ?? {})) {
    values[name] = isShownText(value)
      ? renderShown(value, locale)
      : Array.isArray(value)
        ? value.map((v: unknown) => (isShownText(v) ? renderShown(v, locale) : String(v)))
        : (value as MessageValues[string]);
  }
  return renderMessage(text.key, values, locale);
}
