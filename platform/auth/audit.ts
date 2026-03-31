/**
 * platform/auth/audit.ts — Audit logging
 *
 * Writes immutable audit log entries for all security-relevant events:
 * role changes, permission grants/revokes, entitlement changes,
 * profile updates, admin actions, login events.
 *
 * Uses the service client (bypasses RLS) — audit writes are system operations.
 * The audit_log table has no UPDATE or DELETE policies — append-only by design.
 *
 * Sprint 3, Task 3.6
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

/** Must match the audit_action enum in the database */
export type AuditAction =
  | "role_changed"
  | "permission_granted"
  | "permission_revoked"
  | "entitlement_granted"
  | "entitlement_revoked"
  | "entitlement_expired"
  | "profile_updated"
  | "profile_viewed_by_admin"
  | "password_changed"
  | "password_reset"
  | "mfa_enabled"
  | "mfa_disabled"
  | "device_registered"
  | "device_removed"
  | "account_created"
  | "account_deleted"
  | "account_converted_from_guest"
  | "consent_granted"
  | "consent_revoked"
  | "admin_action"
  | "login_success"
  | "login_failed"
  | "guest_nudge_shown"
  | "guest_locked_out";

export interface AuditEntry {
  action: string;
  actorId?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Write an audit log entry.
 * Fire-and-forget — audit failures are logged but never block the operation.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    const supabase = getSupabaseServiceClient();

    const { error } = await supabase.from("audit_log").insert({
      action: entry.action,
      actor_id: entry.actorId || null,
      target_id: entry.targetId || null,
      details: entry.details || {},
      ip_address: entry.ipAddress || null,
      user_agent: entry.userAgent || null,
    });

    if (error) {
      logger.error("Audit log write failed", {
        error: error.message,
        action: entry.action,
        route: "platform/auth/audit",
      });
    }
  } catch (err) {
    logger.error("Audit log exception", {
      error: err instanceof Error ? err.message : "Unknown error",
      action: entry.action,
      route: "platform/auth/audit",
    });
  }
}

/**
 * Read audit log entries for a specific player.
 * Returns entries where the player is either actor or target.
 * Admin only — RLS enforces this at the database level.
 */
export async function getAuditLogForPlayer(
  playerId: string,
  limit: number = 50
): Promise<AuditEntry[]> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await supabase
    .from("audit_log")
    .select("action, actor_id, target_id, details, ip_address, user_agent, created_at")
    .or(`actor_id.eq.${playerId},target_id.eq.${playerId}`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.map(
    (row: {
      action: string;
      actor_id: string | null;
      target_id: string | null;
      details: Record<string, unknown>;
      ip_address: string | null;
      user_agent: string | null;
    }) => ({
      action: row.action,
      actorId: row.actor_id || undefined,
      targetId: row.target_id || undefined,
      details: row.details,
      ipAddress: row.ip_address || undefined,
      userAgent: row.user_agent || undefined,
    })
  );
}
