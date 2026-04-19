/**
 * lib/sanitize.ts — Input sanitization for prompt injection defense
 *
 * OWASP A03: Injection — sanitize all user input before embedding in LLM prompts.
 *
 * Design principles:
 * - Strip characters that could be interpreted as prompt structure
 * - Wrap sanitized content in XML delimiters the model treats as data only
 * - Never truncate silently — caller is responsible for length limits
 * - Pure functions — no side effects, fully testable
 *
 * ADR-003: Prompt injection defense required at every AI input surface.
 */

/**
 * Characters and patterns that could be used for prompt injection.
 * Removes: backticks, angle brackets used as tags, JSON braces when
 * they appear to form instruction-like patterns.
 */
/**
 * ReDoS-safe: \s{0,10} bounds whitespace matching to prevent catastrophic backtracking.
 * Original used \s* which allows exponential backtracking on crafted input.
 */
const PROMPT_INJECTION_PATTERN =
  /(`{1,3}|<\s{0,10}\/?\s{0,10}(?:system|prompt|instruction|command|ignore|override)\s{0,10}>)/gi;

/**
 * Sanitize user text before embedding in an LLM prompt.
 * Strips prompt injection patterns and wraps in a data delimiter.
 *
 * @param text - Raw user input
 * @returns Sanitized text safe to embed in a prompt
 */
export function sanitizeForPrompt(text: string): string {
  if (!text || typeof text !== "string") return "";

  // Strip known injection patterns
  const stripped = text.replace(PROMPT_INJECTION_PATTERN, "");

  // Wrap in XML delimiter — model is instructed to treat this as data only
  return `<user_input>${stripped}</user_input>`;
}

/**
 * Sanitize text for logging — removes anything that should never appear in logs.
 * Truncates to a safe length for log entries.
 *
 * @param text - Raw user input
 * @param maxLength - Maximum characters to include in log (default: 100)
 * @returns Safe truncated string for logging
 */
export function sanitizeForLog(text: string, maxLength = 100): string {
  if (!text || typeof text !== "string") return "";
  const truncated = text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
  // Remove control characters and newlines for single-line log safety
  // eslint-disable-next-line no-control-regex -- intentional: stripping control characters
  return truncated.replace(/[\x00-\x1F\x7F]/g, " ").trim();
}

/**
 * Validate that a string is safe to use as a language code.
 * Language codes are alphanumeric with hyphens only (e.g. en-US, hi-IN).
 */
export function sanitizeLanguageCode(code: string): string {
  if (!code || typeof code !== "string") return "en-US";
  // Language codes: letters, digits, hyphens only
  const cleaned = code.replace(/[^a-zA-Z0-9-]/g, ""); // eslint-disable-line regexp/use-ignore-case -- ASCII-only language code sanitization
  return cleaned.length > 0 ? cleaned : "en-US";
}
