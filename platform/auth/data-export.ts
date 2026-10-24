/**
 * platform/auth/data-export.ts — GDPR data export
 *
 * Implements the right of access (GDPR Article 15).
 * Users can request a copy of all their stored data.
 *
 * Returns a structured JSON object with data from all
 * registered export modules.
 *
 * Everything is read in the request's tenant (platform/data, ADR-053 D4), in one transaction,
 * so an export holds the user's rows in that tenant and nothing from another. Rows are returned
 * in their JSON form (to_jsonb), as the REST API returned them before.
 *
 * Sprint 5, Task 5.3
 */

import { AuditWriteError, auditRowsForUser, recordAudit } from "@/platform/auth/audit";
import { withTenantTx, type Tx } from "@/platform/data";

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

  // 1–5 in one transaction. A failure stops it; what was read before the failure is kept and
  // the failure is reported, as each failed read was before.
  const rowsOf = async (tx: Tx, text: string): Promise<Record<string, unknown>[]> => {
    const { rows } = await tx.query<{ r: Record<string, unknown> }>(text, [userId]);
    return rows.map((row) => row.r);
  };
  exportData.consents = [];
  exportData.devices = [];
  exportData.entitlements = [];
  exportData.auditLog = [];
  try {
    await withTenantTx(async (tx) => {
      // 1. Core user data
      const users = await rowsOf(
        tx,
        "select to_jsonb(u) as r from users u where u.id = $1::uuid and u.deleted_at is null"
      );
      if (users.length === 1) exportData.profile = users[0];
      else errors.push("users: no live user row");

      // 2. Consent records
      exportData.consents = await rowsOf(
        tx,
        "select to_jsonb(c) as r from consent_records c where c.user_id = $1::uuid"
      );

      // 3. Devices
      exportData.devices = await rowsOf(
        tx,
        "select to_jsonb(d) as r from user_devices d where d.user_id = $1::uuid"
      );

      // 4. Entitlements
      exportData.entitlements = await rowsOf(
        tx,
        "select to_jsonb(e) as r from user_entitlements e where e.user_id = $1::uuid"
      );

      // 5. Audit log (user as actor or target)
      exportData.auditLog = await auditRowsForUser(tx, userId, 500);
    });
  } catch (err) {
    errors.push(`store: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Registered module data
  for (const mod of registeredExportModules) {
    const result = await mod.collectData(userId);
    if (result.error) {
      errors.push(`${mod.moduleName}: ${result.error}`);
    } else {
      exportData[mod.moduleName] = result.data;
    }
  }

  // 7. Metadata
  exportData._meta = {
    exportedAt: new Date().toISOString(),
    userId,
    moduleCount: registeredExportModules.length + 5,
    format: "JSON",
    version: "1.0",
  };

  return { data: exportData, errors };
}

/**
 * Export all user data across all registered modules, as a structured JSON object suitable for
 * download. The export is recorded before anything is disclosed: collecting only reads, the
 * export takes effect when the data is returned, so no record means no data (Adversarial
 * Validation, practice 6).
 */
export async function exportUserData(
  userId: string
): Promise<{ data: Record<string, unknown>; errors: string[] }> {
  const collected = await collectUserData(userId);
  if (collected.errors.includes("invalid user id")) return collected;
  try {
    await recordAudit({
      action: "data_exported",
      actorId: userId,
      targetId: userId,
      details: {
        moduleCount: registeredExportModules.length + 5,
        errorCount: collected.errors.length,
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
