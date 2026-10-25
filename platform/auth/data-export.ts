/**
 * platform/auth/data-export.ts — GDPR data export
 *
 * Implements the right of access (GDPR Article 15).
 * Users can request a copy of all their stored data.
 *
 * Returns a structured JSON object with data from all
 * registered export modules.
 *
 * Everything is read in the request's tenant (platform/data, ADR-053 D4), on one read-only
 * snapshot, so an export holds the user's rows in that tenant and nothing from another. Rows are
 * returned in their JSON form (to_jsonb), as the REST API returned them before.
 *
 * Every row (review 7 M2): each section is read page by page to its end — before, a section
 * stopped at 1000 rows and the audit trail at 500, and nothing said so. An export of more than
 * EXPORT_MAX_ROWS rows is refused whole ("export.too_large"; the route answers
 * account.export_too_large), never cut off; `_meta` says the export is complete and how many
 * rows each section holds. Only the user's own data (M1, M3): no staff member's address, browser,
 * id or notes from the audit trail, no other participant's part of a shared session, and the
 * profile without who changed the account's standing.
 *
 * Sprint 5, Task 5.3
 */

import { AuditWriteError, auditRowsForExport, recordAudit } from "@/platform/auth/audit";
import { withTenantSnapshot, type Tx } from "@/platform/data";
import {
  EXPORT_MAX_ROWS,
  EXPORT_PAGE_SIZE,
  ExportTooLargeError,
  USER_DATA_TABLES,
  exportUserTables,
} from "@/platform/auth/user-data";

/** The error an export over EXPORT_MAX_ROWS rows answers with (nothing is disclosed). */
export const EXPORT_TOO_LARGE = "export.too_large";

/** The platform's own sections: the profile, the audit log and the register's exported tables. */
const PLATFORM_SECTIONS = 2 + USER_DATA_TABLES.filter((t) => t.exportSql).length;

export interface ExportModule {
  moduleName: string;
  description: string;
  /** Collects all data this module holds for the user */
  collectData: (
    userId: string
  ) => Promise<{ data: Record<string, unknown>; error?: string }>;
}

const registeredExportModules: ExportModule[] = [];

/**
 * Register a module's data export handler.
 */
export function registerExportModule(module: ExportModule): void {
  const existing = registeredExportModules.find(
    (m) => m.moduleName === module.moduleName
  );
  if (existing) {
    const idx = registeredExportModules.indexOf(existing);
    registeredExportModules[idx] = module;
    return;
  }
  registeredExportModules.push(module);
}

/**
 * Get all registered export modules.
 */
export function getExportModules(): ExportModule[] {
  return [...registeredExportModules];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collect all of a user's data across all registered modules, without disclosing it. The id is
 * checked first (TASK-145 pattern): a non-UUID never reaches a query.
 */
async function collectUserData(
  userId: string
): Promise<{ data: Record<string, unknown>; errors: string[] }> {
  if (!UUID.test(userId)) return { data: {}, errors: ["invalid user id"] };
  const errors: string[] = [];
  const exportData: Record<string, unknown> = {};

  // The platform's tables in one transaction (platform/auth/user-data.ts: every table that
  // holds the user's data — audit X-15, E-8; before, four of them).
  const rowsOf = async (tx: Tx, text: string): Promise<Record<string, unknown>[]> => {
    const { rows } = await tx.query<{ r: Record<string, unknown> }>(text, [userId]);
    return rows.map((row) => row.r);
  };
  const sectionRows: Record<string, number> = {};
  try {
    await withTenantSnapshot(async (tx) => {
      // Who changed the account's standing is a moderator's id, not the user's data (M4).
      const users = await rowsOf(
        tx,
        "select to_jsonb(u) - 'status_changed_by' as r from users u where u.id = $1::uuid and u.deleted_at is null"
      );
      if (users.length === 1) exportData.profile = users[0];
      else errors.push("users: no live user row");
      const tables = await exportUserTables(tx, userId, {
        pageSize: EXPORT_PAGE_SIZE,
        maxRows: EXPORT_MAX_ROWS,
      });
      let used = 0;
      for (const [name, rows] of Object.entries(tables)) {
        sectionRows[name] = rows.length;
        used += rows.length;
      }
      Object.assign(exportData, tables);
      const audit = await auditRowsForExport(tx, userId, {
        pageSize: EXPORT_PAGE_SIZE,
        maxRows: EXPORT_MAX_ROWS - used,
      });
      exportData.auditLog = audit;
      sectionRows.auditLog = audit.length;
    });
  } catch (err) {
    if (err instanceof ExportTooLargeError)
      return { data: {}, errors: [EXPORT_TOO_LARGE] };
    errors.push(`store: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Registered module data
  for (const mod of registeredExportModules) {
    try {
      const result = await mod.collectData(userId);
      if (result.error) {
        errors.push(`${mod.moduleName}: ${result.error}`);
      } else {
        exportData[mod.moduleName] = result.data;
      }
    } catch (err) {
      errors.push(
        `${mod.moduleName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 7. Metadata
  exportData._meta = {
    exportedAt: new Date().toISOString(),
    userId,
    moduleCount: registeredExportModules.length + PLATFORM_SECTIONS,
    format: "JSON",
    version: "1.1",
    // Every row of every section: nothing is cut off (an export too large is refused instead).
    complete: true,
    maxRows: EXPORT_MAX_ROWS,
    sectionRows,
  };

  return { data: exportData, errors };
}

/**
 * Export all user data across all registered modules, as a structured JSON object suitable for
 * download. The export is recorded before anything is disclosed: collecting only reads, the
 * export takes effect when the data is returned, so no record means no data (Adversarial
 * Validation, practice 6).
 *
 * Complete or not at all (audit RR-23): when any part cannot be read — a table, a module, the
 * profile — nothing is returned, only the errors, so a partial export is never handed over as
 * the user's data.
 */
export async function exportUserData(
  userId: string
): Promise<{ data: Record<string, unknown>; errors: string[] }> {
  const collected = await collectUserData(userId);
  if (collected.errors.length > 0) return { data: {}, errors: collected.errors };
  try {
    await recordAudit({
      action: "data_exported",
      actorId: userId,
      targetId: userId,
      details: {
        moduleCount: registeredExportModules.length + PLATFORM_SECTIONS,
      },
    });
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { data: {}, errors: ["audit unavailable"] };
    throw err;
  }
  return collected;
}

/**
 * Get the size estimate of a user's data export.
 * Useful for showing the user before they trigger the export.
 */
export async function estimateExportSize(
  userId: string
): Promise<{ estimatedBytes: number }> {
  // Only the size leaves this function, so this is not an export and is not recorded as one.
  const { data } = await collectUserData(userId);
  const json = JSON.stringify(data);
  return { estimatedBytes: new TextEncoder().encode(json).length };
}
