/**
 * platform/auth/data-export.ts — GDPR data export
 *
 * Implements the right of access (GDPR Article 15).
 * Players can request a copy of all their stored data.
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
  /** Collects all data this module holds for the player */
  collectData: (
    playerId: string
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
 * Export all player data across all registered modules.
 * Returns a structured JSON object suitable for download.
 */
export async function exportPlayerData(
  playerId: string
): Promise<{ data: Record<string, unknown>; errors: string[] }> {
  const supabase = getSupabaseServiceClient();
  const errors: string[] = [];
  const exportData: Record<string, unknown> = {};

  // 1. Core player data
  const { data: player, error: playerError } = await supabase
    .from("players")
    .select("*")
    .eq("id", playerId)
    .is("deleted_at", null)
    .single();

  if (playerError) {
    errors.push(`players: ${playerError.message}`);
  } else {
    exportData.profile = player;
  }

  // 2. Consent records
  const { data: consents } = await supabase
    .from("consent_records")
    .select("*")
    .eq("player_id", playerId);

  exportData.consents = consents || [];

  // 3. Devices
  const { data: devices } = await supabase
    .from("player_devices")
    .select("*")
    .eq("player_id", playerId);

  exportData.devices = devices || [];

  // 4. Entitlements
  const { data: entitlements } = await supabase
    .from("player_entitlements")
    .select("*")
    .eq("player_id", playerId);

  exportData.entitlements = entitlements || [];

  // 5. Audit log (player as actor or target)
  const { data: auditEntries } = await supabase
    .from("audit_log")
    .select("*")
    .or(`actor_id.eq.${playerId},target_id.eq.${playerId}`)
    .order("created_at", { ascending: false })
    .limit(500);

  exportData.auditLog = auditEntries || [];

  // 6. Registered module data
  for (const mod of registeredExportModules) {
    const result = await mod.collectData(playerId);
    if (result.error) {
      errors.push(`${mod.moduleName}: ${result.error}`);
    } else {
      exportData[mod.moduleName] = result.data;
    }
  }

  // 7. Metadata
  exportData._meta = {
    exportedAt: new Date().toISOString(),
    playerId,
    moduleCount: registeredExportModules.length + 5,
    format: "JSON",
    version: "1.0",
  };

  // 8. Audit log the export
  await writeAuditLog({
    action: "profile_updated",
    actorId: playerId,
    targetId: playerId,
    details: {
      type: "data_export",
      moduleCount: registeredExportModules.length + 5,
      errorCount: errors.length,
    },
  });

  return { data: exportData, errors };
}

/**
 * Get the size estimate of a player's data export.
 * Useful for showing the user before they trigger the export.
 */
export async function estimateExportSize(
  playerId: string
): Promise<{ estimatedBytes: number }> {
  const { data } = await exportPlayerData(playerId);
  const json = JSON.stringify(data);
  return { estimatedBytes: new TextEncoder().encode(json).length };
}
