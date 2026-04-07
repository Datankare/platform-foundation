/**
 * platform/auth/guest-lifecycle.ts — Guest lifecycle management
 *
 * Manages the guest experience lifecycle:
 * 1. Configurable thresholds (nudge, grace, lockout)
 * 2. Guest-to-registered conversion (preserves history)
 * 3. Guest session tracking and cleanup
 *
 * Guest flow:
 *   Guest token created → play sessions counted →
 *   nudge threshold → show registration prompt →
 *   grace period → stronger prompt →
 *   lockout threshold → must register to continue
 *
 * Sprint 5, Tasks 5.4 + 5.5 + 5.6
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export interface GuestConfig {
  nudgeAfterSessions: number;
  graceAfterSessions: number;
  lockoutAfterSessions: number;
  guestTokenTtlHours: number;
  maxGuestSessions: number;
}

const DEFAULT_GUEST_CONFIG: GuestConfig = {
  nudgeAfterSessions: 3,
  graceAfterSessions: 7,
  lockoutAfterSessions: 10,
  guestTokenTtlHours: 72,
  maxGuestSessions: 10,
};

export type GuestPhase = "free_play" | "nudge" | "grace" | "lockout";

export interface GuestStatus {
  guestId: string;
  sessionCount: number;
  phase: GuestPhase;
  config: GuestConfig;
  tokenExpiresAt: string | null;
  isExpired: boolean;
}

/**
 * Get the active guest configuration.
 * Checks guest_config table first, falls back to defaults.
 */
export async function getGuestConfig(): Promise<GuestConfig> {
  const supabase = getSupabaseServiceClient();

  const { data } = await supabase
    .from("guest_config")
    .select("*")
    .eq("is_active", true)
    .single();

  if (!data) return DEFAULT_GUEST_CONFIG;

  return {
    nudgeAfterSessions:
      (data.nudge_after_sessions as number) || DEFAULT_GUEST_CONFIG.nudgeAfterSessions,
    graceAfterSessions:
      (data.grace_after_sessions as number) || DEFAULT_GUEST_CONFIG.graceAfterSessions,
    lockoutAfterSessions:
      (data.lockout_after_sessions as number) ||
      DEFAULT_GUEST_CONFIG.lockoutAfterSessions,
    guestTokenTtlHours:
      (data.guest_token_ttl_hours as number) || DEFAULT_GUEST_CONFIG.guestTokenTtlHours,
    maxGuestSessions:
      (data.max_guest_sessions as number) || DEFAULT_GUEST_CONFIG.maxGuestSessions,
  };
}

/**
 * Determine which lifecycle phase a guest is in based on session count.
 */
export function resolveGuestPhase(sessionCount: number, config: GuestConfig): GuestPhase {
  if (sessionCount >= config.lockoutAfterSessions) return "lockout";
  if (sessionCount >= config.graceAfterSessions) return "grace";
  if (sessionCount >= config.nudgeAfterSessions) return "nudge";
  return "free_play";
}

/**
 * Get the full guest status including phase, session count, and token expiry.
 */
export async function getGuestStatus(guestUserId: string): Promise<GuestStatus | null> {
  const supabase = getSupabaseServiceClient();

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", guestUserId)
    .is("deleted_at", null)
    .single();

  if (!user) return null;

  const config = await getGuestConfig();
  const sessionCount = (user.guest_session_count as number) || 0;
  const phase = resolveGuestPhase(sessionCount, config);

  const tokenExpiresAt = user.guest_token_expires_at as string | null;
  const isExpired = tokenExpiresAt ? new Date(tokenExpiresAt) < new Date() : false;

  return {
    guestId: guestUserId,
    sessionCount,
    phase,
    config,
    tokenExpiresAt,
    isExpired,
  };
}

/**
 * Increment the guest session counter.
 * Called at the start of each guest play session.
 * Returns the new phase (so the UI can show nudge/lockout).
 */
export async function incrementGuestSession(
  guestUserId: string
): Promise<{ phase: GuestPhase; sessionCount: number } | null> {
  const supabase = getSupabaseServiceClient();

  const { data: user } = await supabase
    .from("users")
    .select("guest_session_count")
    .eq("id", guestUserId)
    .single();

  if (!user) return null;

  const currentCount = (user.guest_session_count as number) || 0;
  const newCount = currentCount + 1;

  const { error } = await supabase
    .from("users")
    .update({
      guest_session_count: newCount,
      last_login_at: new Date().toISOString(),
    })
    .eq("id", guestUserId);

  if (error) {
    logger.error("Failed to increment guest session", {
      guestUserId,
      error: error.message,
      route: "platform/auth/guest-lifecycle",
    });
    return null;
  }

  const config = await getGuestConfig();
  const phase = resolveGuestPhase(newCount, config);

  // Audit nudge/lockout transitions
  if (phase === "nudge" && currentCount < config.nudgeAfterSessions) {
    await writeAuditLog({
      action: "guest_nudge_shown",
      actorId: guestUserId,
      targetId: guestUserId,
      details: { sessionCount: newCount },
    });
  }
  if (phase === "lockout" && currentCount < config.lockoutAfterSessions) {
    await writeAuditLog({
      action: "guest_locked_out",
      actorId: guestUserId,
      targetId: guestUserId,
      details: { sessionCount: newCount },
    });
  }

  return { phase, sessionCount: newCount };
}

/**
 * Convert a guest to a registered user.
 * Preserves the user ID and all associated data (play history,
 * entitlements, devices). Only updates the auth fields.
 */
export async function convertGuestToRegistered(
  guestUserId: string,
  cognitoSub: string,
  email: string,
  roleId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseServiceClient();

  const { error } = await supabase
    .from("users")
    .update({
      cognito_sub: cognitoSub,
      email,
      role_id: roleId,
      guest_token: null,
      guest_token_expires_at: null,
      guest_session_count: null,
    })
    .eq("id", guestUserId)
    .is("cognito_sub", null);

  if (error) {
    logger.error("Guest conversion failed", {
      guestUserId,
      error: error.message,
      route: "platform/auth/guest-lifecycle",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "account_converted_from_guest",
    actorId: guestUserId,
    targetId: guestUserId,
    details: { email, roleId },
  });

  return { success: true };
}

/**
 * Clean up expired guest sessions.
 * Called by a scheduled job. Removes guest users whose tokens
 * have expired and who never converted.
 */
export async function cleanupExpiredGuests(): Promise<{
  deletedCount: number;
  error?: string;
}> {
  const supabase = getSupabaseServiceClient();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("users")
    .delete()
    .is("cognito_sub", null)
    .not("guest_token", "is", null)
    .lt("guest_token_expires_at", now)
    .select("id");

  if (error) {
    logger.error("Guest cleanup failed", {
      error: error.message,
      route: "platform/auth/guest-lifecycle",
    });
    return { deletedCount: 0, error: error.message };
  }

  return { deletedCount: data?.length || 0 };
}
