/**
 * platform/auth/gdpr-deletion.ts — GDPR deletion manifest
 *
 * Implements the right to erasure (GDPR Article 17) using a
 * deletion manifest pattern. Each module registers what data
 * it holds for a user, and the manifest coordinates deletion
 * across all registered modules.
 *
 * Two-phase approach:
 * 1. Soft delete — mark user as deleted_at, anonymize PII
 * 2. Hard purge — scheduled job removes all data after retention period
 *
 * Sprint 5, Tasks 5.1 + 5.2
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export interface DeletionModule {
  moduleName: string;
  description: string;
  tables: string[];
  /** Soft delete: anonymize PII, set deleted_at */
  softDelete: (userId: string) => Promise<{ success: boolean; error?: string }>;
  /** Hard purge: permanently remove all data */
  hardPurge: (userId: string) => Promise<{ success: boolean; error?: string }>;
}

const registeredModules: DeletionModule[] = [];

/**
 * Register a module's deletion handler.
 * Called at startup by each module that stores user data.
 */
export function registerDeletionModule(module: DeletionModule): void {
  const existing = registeredModules.find((m) => m.moduleName === module.moduleName);
  if (existing) {
    logger.warn("Deletion module already registered, replacing", {
      moduleName: module.moduleName,
      route: "platform/auth/gdpr-deletion",
    });
    const idx = registeredModules.indexOf(existing);
    registeredModules[idx] = module;
    return;
  }
  registeredModules.push(module);
}

/**
 * Get all registered deletion modules.
 */
export function getDeletionModules(): DeletionModule[] {
  return [...registeredModules];
}

/**
 * Phase 1: Soft delete a user.
 * - Sets deleted_at on the user record
 * - Anonymizes PII (email, display_name, real_name)
 * - Runs soft delete on all registered modules
 * - Audit logged
 */
export async function softDeleteUser(
  userId: string,
  requestedBy: string
): Promise<{ success: boolean; errors: string[] }> {
  const supabase = getSupabaseServiceClient();
  const errors: string[] = [];

  // 1. Anonymize user record
  const anonymized = {
    email: null,
    display_name: "[deleted]",
    real_name: null,
    avatar_url: null,
    date_of_birth: null,
    deleted_at: new Date().toISOString(),
  };

  const { error: userError } = await supabase
    .from("users")
    .update(anonymized)
    .eq("id", userId)
    .is("deleted_at", null);

  if (userError) {
    errors.push(`users: ${userError.message}`);
  }

  // 2. Run soft delete on all registered modules
  for (const mod of registeredModules) {
    const result = await mod.softDelete(userId);
    if (!result.success) {
      errors.push(`${mod.moduleName}: ${result.error || "Unknown error"}`);
    }
  }

  // 3. Record in deletion manifest
  const { error: manifestError } = await supabase.from("deletion_manifest").insert({
    user_id: userId,
    requested_by: requestedBy,
    phase: "soft_delete",
    status: errors.length === 0 ? "completed" : "partial",
    module_results: JSON.stringify(
      registeredModules.map((m) => ({
        module: m.moduleName,
        tables: m.tables,
      }))
    ),
    errors: errors.length > 0 ? JSON.stringify(errors) : null,
  });

  if (manifestError) {
    logger.error("Failed to write deletion manifest", {
      userId,
      error: manifestError.message,
      route: "platform/auth/gdpr-deletion",
    });
  }

  // 4. Audit log
  await writeAuditLog({
    action: "account_deleted",
    actorId: requestedBy,
    targetId: userId,
    details: {
      phase: "soft_delete",
      moduleCount: registeredModules.length,
      errorCount: errors.length,
    },
  });

  return { success: errors.length === 0, errors };
}

/**
 * Phase 2: Hard purge a user's data.
 * Called by a scheduled job after the retention period.
 * Permanently removes all data across all modules.
 */
export async function hardPurgeUser(
  userId: string
): Promise<{ success: boolean; errors: string[] }> {
  const supabase = getSupabaseServiceClient();
  const errors: string[] = [];

  // 1. Run hard purge on all registered modules
  for (const mod of registeredModules) {
    const result = await mod.hardPurge(userId);
    if (!result.success) {
      errors.push(`${mod.moduleName}: ${result.error || "Unknown error"}`);
    }
  }

  // 2. Delete user record
  const { error: userError } = await supabase.from("users").delete().eq("id", userId);

  if (userError) {
    errors.push(`users: ${userError.message}`);
  }

  // 3. Update deletion manifest
  const { error: manifestError } = await supabase
    .from("deletion_manifest")
    .update({
      phase: "hard_purge",
      status: errors.length === 0 ? "completed" : "partial",
      purged_at: new Date().toISOString(),
      errors: errors.length > 0 ? JSON.stringify(errors) : null,
    })
    .eq("user_id", userId);

  if (manifestError) {
    logger.error("Failed to update deletion manifest", {
      userId,
      error: manifestError.message,
      route: "platform/auth/gdpr-deletion",
    });
  }

  return { success: errors.length === 0, errors };
}
