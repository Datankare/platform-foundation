/**
 * GDPR Hard Purge — Complete data deletion pipeline.
 *
 * Orchestrates deletion of all user data across:
 * - Supabase database tables
 * - Supabase storage buckets
 * - Cache entries
 * - Rate limit entries
 * - Audit trail (anonymized, not deleted — regulatory requirement)
 *
 * Interface-first: PurgeHandler abstraction allows consumers
 * to register app-specific deletion steps.
 *
 * @module platform/gdpr
 * @see ROADMAP.md Phase 2 Sprint 4 — GDPR hard purge
 */

/** Status of a purge operation */
export type PurgeStatus = "pending" | "in-progress" | "completed" | "failed" | "partial";

/** Individual step result in the purge pipeline */
export interface PurgeStepResult {
  /** Handler name (e.g., "supabase:profiles", "cache:user-data") */
  handler: string;
  /** Whether this step succeeded */
  success: boolean;
  /** Number of records/items deleted */
  deletedCount: number;
  /** Error message if failed */
  error?: string;
  /** Duration in ms */
  durationMs: number;
}

/** Complete purge operation result */
export interface PurgeResult {
  /** Unique purge operation ID */
  purgeId: string;
  /** User ID being purged */
  userId: string;
  /** Overall status */
  status: PurgeStatus;
  /** Individual step results */
  steps: PurgeStepResult[];
  /** When the purge was requested (ISO string) */
  requestedAt: string;
  /** When the purge completed (ISO string) */
  completedAt: string | null;
  /** Total records deleted across all steps */
  totalDeleted: number;
}

/** Purge request input */
export interface PurgeRequest {
  /** User ID to purge */
  userId: string;
  /** Who requested the purge (admin ID or "self") */
  requestedBy: string;
  /** Reason for purge (audit trail) */
  reason: "user-request" | "admin-action" | "account-deletion" | "legal-order";
  /** If true, perform a dry run — report what would be deleted without deleting */
  dryRun?: boolean;
}

/**
 * A purge handler deletes data from one specific system.
 * Consumers register handlers for their app-specific data stores.
 */
export interface PurgeHandler {
  /** Handler name — must be unique across the pipeline */
  readonly name: string;
  /** Execution order priority (lower = earlier). Default: 100. */
  readonly priority: number;
  /**
   * Execute deletion for the given user.
   * @returns Number of records/items deleted
   */
  execute(userId: string, dryRun: boolean): Promise<number>;
}

/** Configuration for the purge pipeline */
export interface PurgeConfig {
  /** Maximum time for the entire purge operation in ms. Default: 30000. */
  timeoutMs?: number;
  /** Whether to continue on individual step failure. Default: true. */
  continueOnError?: boolean;
}

/** Purge audit log entry (stored in purge_log table) */
export interface PurgeAuditEntry {
  purge_id: string;
  user_id: string;
  requested_by: string;
  reason: string;
  status: PurgeStatus;
  steps_json: string;
  total_deleted: number;
  requested_at: string;
  completed_at: string | null;
}
