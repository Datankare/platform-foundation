/**
 * platform/auth/consent.ts — Consent records service
 *
 * Tracks what the player agreed to, when, and which version.
 * GDPR requires purpose limitation — we can only use data for
 * the purposes the player consented to.
 *
 * Sprint 4, Task 4.8
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export interface ConsentRecord {
  id: string;
  playerId: string;
  consentType: string;
  consentVersion: string;
  granted: boolean;
  grantedAt: string;
  revokedAt: string | null;
}

/**
 * Record a player's consent for a specific purpose.
 */
export async function grantConsent(params: {
  playerId: string;
  consentType: string;
  consentVersion: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase.from("consent_records").insert({
    player_id: params.playerId,
    consent_type: params.consentType,
    consent_version: params.consentVersion,
    granted: true,
    ip_address: params.ipAddress || null,
    user_agent: params.userAgent || null,
  });

  if (error) {
    logger.error("Consent grant failed", {
      playerId: params.playerId,
      consentType: params.consentType,
      error: error.message,
      route: "platform/auth/consent",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "consent_granted",
    actorId: params.playerId,
    targetId: params.playerId,
    details: {
      consentType: params.consentType,
      consentVersion: params.consentVersion,
    },
  });

  return { success: true };
}

/**
 * Revoke a player's consent for a specific purpose.
 * Sets revoked_at — does not delete the record (audit trail).
 */
export async function revokeConsent(params: {
  playerId: string;
  consentType: string;
}): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase
    .from("consent_records")
    .update({ revoked_at: new Date().toISOString() })
    .eq("player_id", params.playerId)
    .eq("consent_type", params.consentType)
    .is("revoked_at", null);

  if (error) {
    logger.error("Consent revocation failed", {
      playerId: params.playerId,
      consentType: params.consentType,
      error: error.message,
      route: "platform/auth/consent",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "consent_revoked",
    actorId: params.playerId,
    targetId: params.playerId,
    details: { consentType: params.consentType },
  });

  return { success: true };
}

/**
 * Get all active consent records for a player.
 */
export async function getPlayerConsents(playerId: string): Promise<ConsentRecord[]> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await supabase
    .from("consent_records")
    .select("*")
    .eq("player_id", playerId)
    .is("revoked_at", null)
    .order("granted_at", { ascending: false });

  if (error || !data) return [];

  return data.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    playerId: row.player_id as string,
    consentType: row.consent_type as string,
    consentVersion: row.consent_version as string,
    granted: row.granted as boolean,
    grantedAt: row.granted_at as string,
    revokedAt: row.revoked_at as string | null,
  }));
}

/**
 * Check if a player has active consent for a specific type.
 */
export async function hasConsent(
  playerId: string,
  consentType: string
): Promise<boolean> {
  const consents = await getPlayerConsents(playerId);
  return consents.some((c) => c.consentType === consentType);
}
