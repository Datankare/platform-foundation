/**
 * shared/config/limits.ts — Platform-wide constants and configuration
 *
 * Single source of truth for all magic numbers and configurable limits.
 */

/** Maximum input length for the translation pipeline */
export const MAX_INPUT_CHARACTERS = 100;

/** Maximum number of target languages per request */
export const MAX_TARGET_LANGUAGES = 10;

/** Default request timeout in milliseconds */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Rate limit: requests per minute per IP */
export const RATE_LIMIT_REQUESTS_PER_MINUTE = 60;

/** Admin UI: highlight duration for newly created/modified rows (seconds) */
export const ADMIN_HIGHLIGHT_DURATION_SECONDS = 15;

/** Admin UI: minimum highlight duration (seconds) */
export const ADMIN_HIGHLIGHT_MIN_SECONDS = 5;

/** Admin UI: maximum highlight duration (seconds) */
export const ADMIN_HIGHLIGHT_MAX_SECONDS = 30;
