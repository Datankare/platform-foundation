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
import { writeAuditLog } from "@/platform/auth/audit";

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

/**
 * Export all user data across all registered modules.
 * Returns a structured JSON object suitable for download.
 */
export async function exportUserData(
  userId: string
): Promise<{ data: Record<string, unknown>; errors: string[] }> {
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
  const { data: auditEntries } = await supabase
    .from("audit_log")
    .select("*")
    .or(`actor_id.eq.${userId},target_id.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(500);

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

  // 8. Audit log the export
  await writeAuditLog({
    action: "profile_updated",
    actorId: userId,
    targetId: userId,
    details: {
      type: "data_export",
      moduleCount: registeredExportModules.length + 5,
      errorCount: errors.length,
    },
  });

  return { data: exportData, errors };
}

/**
 * Get the size estimate of a user's data export.
 * Useful for showing the user before they trigger the export.
 */
export async function estimateExportSize(
  userId: string
): Promise<{ estimatedBytes: number }> {
  const { data } = await exportUserData(userId);
  const json = JSON.stringify(data);
  return { estimatedBytes: new TextEncoder().encode(json).length };
}
