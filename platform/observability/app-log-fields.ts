/**
 * platform/observability/app-log-fields.ts — The consuming app's own log field names (TASK-215,
 * audit A-10)
 *
 * CONSUMER-OWNED. platform-foundation ships this file empty; an app that consumes it classifies the
 * field names its own log calls pass and lists this path in its sync exclude list, so the sync
 * never overwrites it — as platform/auth/app-audit-details.ts does for audit keys. The platform's
 * fields live in lib/log-fields.ts, which merges the two; the logger redacts the "redacted" ones.
 *
 * Each entry is "kept: <why>" or "redacted: <why>" (__tests__/log-fields.test.ts holds every log
 * call's fields to the two registers, and every entry to that form).
 *
 * @module platform/observability
 */

/** The app's own log field names: "kept: <why>" or "redacted: <why>". */
export const APP_LOG_FIELDS: Readonly<Record<string, string>> = {};
