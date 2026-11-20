/**
 * platform/auth/app-json-columns.ts — a consuming app's own jsonb columns (platform TASK-229)
 *
 * The platform's register (platform/errors/json-columns.ts) lists every jsonb column of the
 * platform's schema, the most any writer stores in it and what keeps it within the database's
 * bound on stored JSON (migration 074). An app that adds tables with jsonb columns lists them here,
 * in the same shape; `__tests__/db/json-columns.db.test.ts` (@guard) compares both lists with the
 * database's catalogue, so an unlisted column fails CI. Migration 074 bounds every jsonb column
 * present when it is applied; an app's later migration that adds one calls
 * `select public.json_bound_install(array['public.<table>'::regclass]);` then
 * `select public.json_bound_check('public.<table>');` (ADR-058), or readiness (probe json-bound)
 * names the table.
 *
 * The app's own file: excluded from the sync (docs/templates/sync-config.json). The platform has
 * none.
 */

import type { JsonColumn } from "@/platform/errors/json-columns";

export const APP_JSON_COLUMNS: readonly JsonColumn[] = [];
