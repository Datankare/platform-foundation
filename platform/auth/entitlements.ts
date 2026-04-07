/**
 * platform/auth/entitlements.ts — Entitlements engine
 *
 * Manages entitlement groups and user-to-group assignments.
 * Entitlements are additive grants on top of the primary role —
 * they never remove permissions, only add.
 *
 * All mutations go through the service client (bypasses RLS)
 * and are audit-logged.
 *
 * Sprint 3, Task 3.3
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { writeAuditLog } from "@/platform/auth/audit";

export interface EntitlementGrant {
  userId: string;
  entitlementGroupId: string;
  grantedBy: string;
  expiresAt?: string;
}

export interface EntitlementRevoke {
  userId: string;
  entitlementGroupId: string;
  revokedBy: string;
}

/**
 * Grant an entitlement group to a user.
 * Idempotent — if the user already has the entitlement, updates expiry.
 */
export async function grantEntitlement(
  grant: EntitlementGrant
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  try {
    const { error } = await supabase.from("user_entitlements").upsert(
      {
        user_id: grant.userId,
        entitlement_group_id: grant.entitlementGroupId,
        granted_by: grant.grantedBy,
        expires_at: grant.expiresAt || null,
        revoked_at: null,
      },
      { onConflict: "user_id,entitlement_group_id" }
    );

    if (error) {
      logger.error("Failed to grant entitlement", {
        error: error.message,
        route: "platform/auth/entitlements",
      });
      return { success: false, error: error.message };
    }

    await writeAuditLog({
      action: "entitlement_granted",
      actorId: grant.grantedBy,
      targetId: grant.userId,
      details: {
        entitlementGroupId: grant.entitlementGroupId,
        expiresAt: grant.expiresAt || null,
      },
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Grant failed";
    logger.error("Entitlement grant error", {
      error: message,
      route: "platform/auth/entitlements",
    });
    return { success: false, error: message };
  }
}

/**
 * Revoke an entitlement group from a user.
 * Sets revoked_at — does not delete the record (audit trail preserved).
 */
export async function revokeEntitlement(
  revoke: EntitlementRevoke
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  try {
    const { error } = await supabase
      .from("user_entitlements")
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: revoke.revokedBy,
      })
      .eq("user_id", revoke.userId)
      .eq("entitlement_group_id", revoke.entitlementGroupId)
      .is("revoked_at", null);

    if (error) {
      logger.error("Failed to revoke entitlement", {
        error: error.message,
        route: "platform/auth/entitlements",
      });
      return { success: false, error: error.message };
    }

    await writeAuditLog({
      action: "entitlement_revoked",
      actorId: revoke.revokedBy,
      targetId: revoke.userId,
      details: {
        entitlementGroupId: revoke.entitlementGroupId,
      },
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Revoke failed";
    logger.error("Entitlement revoke error", {
      error: message,
      route: "platform/auth/entitlements",
    });
    return { success: false, error: message };
  }
}

/**
 * Get all active entitlements for a user.
 */
export async function getUserEntitlements(
  userId: string
): Promise<{ entitlementGroupId: string; code: string; expiresAt: string | null }[]> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await supabase
    .from("user_entitlements")
    .select("entitlement_group_id, expires_at")
    .eq("user_id", userId)
    .is("revoked_at", null);

  if (error || !data) return [];

  const now = new Date().toISOString();
  const activeIds = data
    .filter((e: { expires_at: string | null }) => !e.expires_at || e.expires_at > now)
    .map((e: { entitlement_group_id: string }) => e.entitlement_group_id);

  if (activeIds.length === 0) return [];

  const { data: groups } = await supabase
    .from("entitlement_groups")
    .select("id, code")
    .in("id", activeIds)
    .eq("is_active", true);

  return (groups || []).map((g: { id: string; code: string }) => ({
    entitlementGroupId: g.id,
    code: g.code,
    expiresAt:
      data.find((e: { entitlement_group_id: string }) => e.entitlement_group_id === g.id)
        ?.expires_at || null,
  }));
}
