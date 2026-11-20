/**
 * __tests__/helpers/app-shell-text.ts — the app header's signed-in line, as the catalogue words it
 * (Playform TASK-5031)
 *
 * The header (components/app/ui/AppShell.tsx) shows the signed-in address as the catalogue's
 * `screens.app_shell.signed_in_as` — "Signed in as {email}" — not the bare address. Playform's
 * live journeys looked for the bare address as an exact text and failed on the first deployment of
 * the new header; nobody can run them locally. Every test that looks for that line — the header's
 * component tests and the live journeys alike — takes it from here, so none can drift from the
 * header again.
 */

import messages from "../../messages/en.json";

/**
 * "Signed in as <email>", exactly as the header renders it in English. The address goes in through
 * a function: given as the replacement text itself, "$&" or "$1" inside an address would be read
 * as a replacement pattern and expanded (code review B-29).
 */
export function signedInLine(email: string): string {
  return messages.screens.app_shell.signed_in_as.replace("{email}", () => email);
}
