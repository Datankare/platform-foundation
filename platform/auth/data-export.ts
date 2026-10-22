/**
 * platform/auth/data-export.ts — GDPR data export
 *
 * Implements the right of access (GDPR Article 15).
 * Users can request a copy of all their stored data.
 *
 * Returns a structured JSON object with data from all
 * registered export modules.
 *
 * Sprint 5, Task 5.3
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { AuditWriteError, auditRowsForUser, recordAudit } from "@/platform/auth/audit";

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
 * checked first: it is used in a filter string below, where a crafted value could widen the
 * read to other users' audit records (TASK-145 pattern).
 */
async function collectUserData(
  userId: string
): Promise<{ data: Record<string, unknown>; errors: string[] }> {
  if (!UUID.test(userId)) return { data: {}, errors: ["invalid user id"] };
  const supabase = getSupabaseServiceClient();
  const errors: string[] = [];
  const exportData: Record<string, unknown> = {};

  // 1. Core user data
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .is("deleted_at", null)
    .single();

  if (userError) {
    errors.push(`users: ${userError.message}`);
  } else {
    exportData.profile = user;
  }

  // 2. Consent records
  const { data: consents } = await supabase
    .from("consent_records")
    .select("*")
    .eq("user_id", userId);

  exportData.consents = consents || [];

  // 3. Devices
  const { data: devices } = await supabase
    .from("user_devices")
    .select("*")
    .eq("user_id", userId);

  exportData.devices = devices || [];

  // 4. Entitlements
  const { data: entitlements } = await supabase
    .from("user_entitlements")
    .select("*")
    .eq("user_id", userId);

  exportData.entitlements = entitlements || [];

  // 5. Audit log (user as actor or target)
  const { data: auditEntries } = await auditRowsForUser(supabase, userId, "*", 500);

  exportData.auditLog = auditEntries || [];

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
