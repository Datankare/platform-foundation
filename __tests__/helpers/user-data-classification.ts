/**
 * __tests__/helpers/user-data-classification.ts — which tables and columns are classified for
 * the rights of erasure and access, in platform-foundation and in any app that inherits the
 * coverage test unchanged.
 *
 * The platform classifies its own tables (platform/auth/user-data.ts: USER_DATA_TABLES and
 * NO_USER_DATA, with their columns). An app classifies its own by declaring them:
 *   - a table its deletion module erases: named by the module's row in deletion_manifest (the
 *     app's migration registers it, as Playform's 052b does) or by a deletion module registered
 *     with registerDeletionModule (DeletionModule.tables);
 *   - a table that holds no user's data: in platform/modules/app-manifest.json "noUserData",
 *     with the reason.
 * The app's module answers for every column of its tables. A table nobody declares is
 * unclassified, in an app as in the platform: the test fails until it is declared.
 */

/** The deletion_manifest modules the platform itself wrote (002's seed, 052's register). */
export const PLATFORM_MANIFEST_MODULES: ReadonlySet<string> = new Set([
  "platform",
  "auth",
  "permissions",
  "audit",
]);

export interface Declarations {
  /** The platform's tables (both registers). */
  readonly platformTables: ReadonlySet<string>;
  /** Tables an app's deletion modules name: deletion_manifest rows and registered modules. */
  readonly appErased: ReadonlySet<string>;
  /** The app manifest's noUserData tables. */
  readonly appNoUserData: ReadonlySet<string>;
}

/** The app's deletion-manifest tables: every row that is not one the platform wrote. */
export function appManifestTables(
  rows: readonly { module_name: string; table_names: readonly string[] }[]
): string[] {
  return rows
    .filter((r) => !PLATFORM_MANIFEST_MODULES.has(r.module_name))
    .flatMap((r) => r.table_names);
}

/** The schema's tables nobody classifies. */
export function unclassifiedTables(tables: readonly string[], d: Declarations): string[] {
  return tables.filter(
    (t) => !d.platformTables.has(t) && !d.appErased.has(t) && !d.appNoUserData.has(t)
  );
}

/** Declarations naming a table the schema does not have. */
export function declaredButAbsent(tables: readonly string[], d: Declarations): string[] {
  const present = new Set(tables);
  return [...d.platformTables, ...d.appErased, ...d.appNoUserData].filter(
    (t) => !present.has(t)
  );
}

/** Whether a column (`table.column`) is the app's to answer for: one of its declared tables. */
export function isAppColumn(column: string, d: Declarations): boolean {
  const table = column.split(".")[0];
  return (
    !d.platformTables.has(table) && (d.appErased.has(table) || d.appNoUserData.has(table))
  );
}
