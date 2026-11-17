/**
 * components/refusal/refusal-words.ts — a refusal's details in a person's words (TASK-224,
 * SF-app-062)
 *
 * A restricted account read "Account status: restricted" — the stored code, in lower case — and a
 * rate limit "You can try again in 3600 seconds". Both refusal displays (the user's
 * RefusalNotice and the console's RefusalExtras) say them through these: the standing by its
 * catalogue name, and a wait in hours, minutes or seconds as a person counts it.
 *
 * Client-safe; every word is the catalogue's (screens.refusal).
 *
 * @module components/refusal
 */

import { renderMessage } from "@/platform/errors/messages";

/** An account's standing by name ("restricted" → "Restricted"); one the catalogue lacks: "Limited". */
export function accountStatusLabel(status: string): string {
  const key = `screens.refusal.status.${status}`;
  const text = renderMessage(key);
  return text === key ? renderMessage("screens.refusal.status.other") : text;
}

/**
 * A wait as a person counts it: under a minute in seconds, under an hour in whole minutes
 * (rounded up — never sooner than the server said), else hours and minutes.
 */
export function waitText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return renderMessage("screens.refusal.duration.seconds", { count: s });
  const minutes = Math.ceil(s / 60);
  if (minutes < 60)
    return renderMessage("screens.refusal.duration.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? renderMessage("screens.refusal.duration.hours", { count: hours })
    : renderMessage("screens.refusal.duration.hours_minutes", { hours, minutes: rest });
}
