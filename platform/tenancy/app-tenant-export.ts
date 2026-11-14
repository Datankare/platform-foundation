/**
 * platform/tenancy/app-tenant-export.ts — The consuming app's own tenant tables' columns in an
 * operator's tenant export (TASK-215, audit A-7)
 *
 * CONSUMER-OWNED. platform-foundation ships this file empty; an app whose own tables hold a
 * tenant's rows classifies each of their columns here and lists this path in its sync exclude
 * list, so the sync never overwrites it — as platform/auth/app-audit-details.ts does for audit
 * keys. The platform's tables are classified in platform/auth/user-data.ts TENANT_EXPORT_COLUMNS;
 * the export (platform/tenancy/admin.ts writeTenantExport) reads only the columns either says are
 * exported, and refuses a table neither classifies.
 *
 * Each entry is "<table>.<column>" → "exported: <why>" or "not exported: <why>"
 * (__tests__/db/export-columns.db.test.ts holds every column of every tenant table to the two, and
 * every entry to that form).
 *
 * @module platform/tenancy
 */

/** The app's own tenant tables' columns: "exported: <why>" or "not exported: <why>". */
export const APP_TENANT_EXPORT: Readonly<Record<string, string>> = {};
