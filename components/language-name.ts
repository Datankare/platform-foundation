/**
 * components/language-name.ts — a language's name on an app's screens (TASK-205)
 *
 * From the app's catalog (messages/app/en.json, screens.app.languages.<code>), never from a list
 * in a component or the name an API answer carries: one place to translate. A code the catalog
 * does not name falls back to `fallback`, or to the code in capitals.
 */
import { renderMessage } from "@/platform/errors/messages";

export function languageName(code: string, fallback?: string): string {
  const key = `screens.app.languages.${code}`;
  const name = renderMessage(key);
  return name === key ? (fallback ?? code.toUpperCase()) : name;
}
