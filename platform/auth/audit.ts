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
 * A security-relevant action is recorded BEFORE it takes effect and does not run when the record
 * cannot be written (audited(), recordAudit()). Until Sprint 7X every write was fire-and-forget:
 * placeholder actor ids and an action the enum rejected meant whole classes of admin and
 * moderation actions were never recorded, and nothing noticed (audit X-8).
 *
 * Sprint 3, Task 3.6 · Sprint 7X (fail closed)
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Must match the audit_action enum in the database */
/** Every action an audit record may carry; each must be accepted by the audit_action enum
 *  (checked by scripts/migration-replay.sh). */
export const AUDIT_ACTIONS = [
  "role_changed",
  "permission_granted",
  "permission_revoked",
  "entitlement_granted",
  "entitlement_revoked",
  "entitlement_expired",
  "profile_updated",
  "profile_viewed_by_admin",
  "password_changed",
  "password_reset",
  "mfa_enabled",
  "mfa_disabled",
  "device_registered",
  "device_removed",
  "account_created",
  "account_deleted",
  "account_converted_from_guest",
  "consent_granted",
  "consent_revoked",
  "admin_action",
  "login_success",
  "login_failed",
  "guest_nudge_shown",
  "guest_locked_out",
  "gdpr_purge_executed",
  "gdpr_purge_dry_run",
  "data_exported",
  "consent_denied",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  action: AuditAction;
  /** The person who acted: a users.id. Never a placeholder — a non-id is refused. */
  actorId?: string;
  /** The agent or system process that acted, when no person did (e.g. "escalation-reaper"). */
  agent?: string;
  /** The person acted upon: a users.id. */
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/** An audit record could not be written, so the action it records must not proceed. */
export class AuditWriteError extends Error {
  constructor(
    readonly action: AuditAction,
    cause: string
  ) {
    super(`Audit record for ${action} could not be written: ${cause}`);
    this.name = "AuditWriteError";
  }
}

/**
 * Write an audit record, or throw AuditWriteError. Use for every security-relevant action —
 * through audited() when the record must precede the action.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  // Placeholder actor ids ("authenticated-admin", "dev-admin", agent names) went into a uuid
  // column, failed, and were swallowed (audit X-8). An agent or process is named in `agent`.
  for (const [field, value] of [
    ["actorId", entry.actorId],
    ["targetId", entry.targetId],
  ] as const) {
    if (value && !UUID.test(value)) {
      logger.error("Audit record refused: not a user id", {
        field,
        action: entry.action,
        route: "platform/auth/audit",
      });
      throw new AuditWriteError(entry.action, `${field} is not a user id`);
    }
  }
  let failure: string | undefined;
  try {
    const supabase = getSupabaseServiceClient();
    const { error } = await supabase.from("audit_log").insert({
      action: entry.action,
      actor_id: entry.actorId || null,
      target_id: entry.targetId || null,
      details: entry.agent
        ? { ...entry.details, agent: entry.agent }
        : entry.details || {},
      ip_address: entry.ipAddress || null,
      user_agent: entry.userAgent || null,
    });
    if (error) failure = error.message;
  } catch (err) {
    failure = err instanceof Error ? err.message : "Unknown error";
  }
  if (failure !== undefined) {
    logger.error("Audit record could not be written", {
      error: failure,
      action: entry.action,
      actorId: entry.actorId,
      targetId: entry.targetId,
      route: "platform/auth/audit",
    });
    throw new AuditWriteError(entry.action, failure);
  }
}

/** Whether an action's result reports failure ({ success: false } or { error }). */
function reportsFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { success?: unknown; error?: unknown };
  return r.success === false || (r.error !== undefined && r.error !== null);
}

/**
 * Record `entry`, then run `act`. If the record cannot be written, `act` never runs and
 * AuditWriteError is thrown. If `act` reports failure or throws, a follow-up record says so
 * (best effort — the attempt is already on file).
 */
export async function audited<T>(entry: AuditEntry, act: () => Promise<T>): Promise<T> {
  await recordAudit({ ...entry, details: { ...entry.details, outcome: "attempted" } });
  let result: T;
  try {
    result = await act();
  } catch (err) {
    await recordOutcome(entry, err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (reportsFailure(result)) {
    const error = (result as { error?: unknown }).error;
    await recordOutcome(entry, typeof error === "string" ? error : "reported failure");
  }
  return result;
}

async function recordOutcome(entry: AuditEntry, reason: string): Promise<void> {
  try {
    await recordAudit({
      ...entry,
      details: { ...entry.details, outcome: "failed", reason: reason.slice(0, 500) },
    });
  } catch {
    // Already logged by recordAudit; the attempt record stands.
  }
}

/**
 * Write an audit entry without blocking the caller on failure — for events that are records of
 * something already done elsewhere and must not undo it (sign-in telemetry, nudges). Failures
 * are logged. Every security-relevant action uses audited() or recordAudit() instead.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry);
  } catch {
    // Logged by recordAudit.
  }
}

/**
 * Audit rows where `userId` is the actor or the target, newest first, at most `limit` — two
 * bound-filter queries merged, never a filter string (release review, Sprint 7X).
 */
export async function auditRowsForUser<Row extends { created_at?: string; id?: string }>(
  supabase: ReturnType<typeof getSupabaseServiceClient>,
  userId: string,
  columns: string,
  limit: number
): Promise<{ data: Row[] | null; error: { message: string } | null }> {
  const side = (column: "actor_id" | "target_id") =>
    supabase
      .from("audit_log")
      .select(columns.includes("id,") || columns === "*" ? columns : `id, ${columns}`)
      .eq(column, userId)
      .order("created_at", { ascending: false })
      .limit(limit) as unknown as Promise<{
      data: Row[] | null;
      error: { message: string } | null;
    }>;
  const [asActor, asTarget] = await Promise.all([side("actor_id"), side("target_id")]);
  const error = asActor.error ?? asTarget.error;
  if (error) return { data: null, error };
  const merged = new Map<string, Row>();
  for (const row of [...(asActor.data ?? []), ...(asTarget.data ?? [])]) {
    merged.set(String(row.id ?? `${row.created_at}:${merged.size}`), row);
  }
  const data = [...merged.values()]
    .sort((a, b) =>
      String(a.created_at) < String(b.created_at)
        ? 1
        : String(a.created_at) > String(b.created_at)
          ? -1
          : 0
    )
    .slice(0, limit);
  return { data, error: null };
}

/**
 * Read audit log entries for a specific user.
 * Returns entries where the user is either actor or target.
 * Admin only — RLS enforces this at the database level.
 */
export async function getAuditLogForUser(
  userId: string,
  limit: number = 50
): Promise<AuditEntry[]> {
  const supabase = getSupabaseServiceClient();

  // The id is checked, never spliced into a filter string as-is: a crafted value could widen
  // the filter to other users' records (TASK-145 pattern).
  if (!UUID.test(userId)) return [];
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || 50, 500));
  const { data, error } = await auditRowsForUser<{
    action: string;
    actor_id: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
    ip_address: string | null;
    user_agent: string | null;
    created_at: string;
  }>(
    supabase,
    userId,
    "action, actor_id, target_id, details, ip_address, user_agent, created_at",
    bounded
  );

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
      action: row.action as AuditAction,
      actorId: row.actor_id || undefined,
      targetId: row.target_id || undefined,
      details: row.details,
      ipAddress: row.ip_address || undefined,
      userAgent: row.user_agent || undefined,
    })
  );
}

/**
 * For API routes: run `act` under audited(), returning its response, or a 503 coded error when
 * the audit record cannot be written (the action then never ran). `act` reports success so a
 * failed action gets its follow-up record.
 */
export async function auditedResponse<R>(
  entry: AuditEntry,
  act: () => Promise<{
    readonly success: boolean;
    readonly error?: string;
    readonly response: R;
  }>,
  unavailable: () => R
): Promise<R> {
  try {
    return (await audited(entry, act)).response;
  } catch (err) {
    if (err instanceof AuditWriteError) return unavailable();
    throw err;
  }
}
