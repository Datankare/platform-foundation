/**
 * platform/admin/config-approval.ts — Two-person approval service
 *
 * Manages the approval workflow for safety-critical config changes.
 * Built in but DISABLED by default (config.require_two_person_approval = false).
 *
 * When enabled:
 *   1. Safety-tier config changes create a pending approval instead of applying
 *   2. A different super_admin reviews and approves/rejects with a comment
 *   3. On approval, the change is applied via setConfigWithHistory()
 *   4. Pending approvals expire after config.approval_expiry_days (default 7)
 *
 * Self-approval is blocked — the requester cannot approve their own change.
 *
 * GenAI Principles:
 *   P10 — Human oversight: two humans must agree on safety-critical changes
 *   P3  — Total observability: every approval action logged
 *   P11 — Resilient degradation: if approval check fails, fail-closed (require approval)
 *   P13 — Control plane: approval requirement is itself a config flag
 *
 * @module platform/admin
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { getConfig } from "@/platform/auth/platform-config";
import type {
  ConfigApprovalRecord,
  ConfigApprovalStatus,
  ConfigApprovalQueryOptions,
} from "./types";

// ---------------------------------------------------------------------------
// DB row shape
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  config_key: string;
  current_value: unknown;
  proposed_value: unknown;
  requested_by: string | null;
  change_comment: string;
  impact_summary: string | null;
  status: string;
  reviewed_by: string | null;
  review_comment: string | null;
  reviewed_at: string | null;
  expires_at: string;
  created_at: string;
}

/** Map a DB row to a ConfigApprovalRecord */
function mapApprovalRow(row: ApprovalRow): ConfigApprovalRecord {
  return {
    id: row.id,
    configKey: row.config_key,
    currentValue: row.current_value,
    proposedValue: row.proposed_value,
    requestedBy: row.requested_by,
    changeComment: row.change_comment,
    impactSummary: row.impact_summary,
    status: parseApprovalStatus(row.status),
    reviewedBy: row.reviewed_by,
    reviewComment: row.review_comment,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** Parse approval status string. Falls back to "pending". */
function parseApprovalStatus(raw: string): ConfigApprovalStatus {
  const valid: ReadonlySet<string> = new Set([
    "pending",
    "approved",
    "rejected",
    "expired",
  ]);
  return valid.has(raw) ? (raw as ConfigApprovalStatus) : "pending";
}

// ---------------------------------------------------------------------------
// Feature flag check
// ---------------------------------------------------------------------------

/**
 * Check whether two-person approval is enabled.
 * Fail-closed: if config is unavailable, assume approval IS required (P11).
 */
export async function isApprovalRequired(): Promise<boolean> {
  try {
    return await getConfig<boolean>("config.require_two_person_approval", false);
  } catch {
    // P11: fail-closed — require approval if we can't check
    logger.warn("Could not check approval requirement — failing closed", {
      route: "platform/admin/config-approval",
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

/** Column list for approval queries */
const APPROVAL_COLUMNS =
  "id, config_key, current_value, proposed_value, requested_by, change_comment, impact_summary, status, reviewed_by, review_comment, reviewed_at, expires_at, created_at";

/**
 * Create a pending approval request.
 * Returns the created record or an error.
 */
export async function requestApproval(params: {
  configKey: string;
  currentValue: unknown;
  proposedValue: unknown;
  requestedBy: string;
  changeComment: string;
  impactSummary?: string;
}): Promise<{ success: boolean; record?: ConfigApprovalRecord; error?: string }> {
  try {
    const supabase = getSupabaseServiceClient();

    // Check for existing pending approval on the same key
    const { data: existing } = await (supabase
      .from("config_pending_approvals" as never)
      .select("id")
      .eq("config_key", params.configKey)
      .eq("status", "pending")
      .limit(1) as unknown as Promise<{
      data: Array<{ id: string }> | null;
      error: { message: string } | null;
    }>);

    if (existing && existing.length > 0) {
      return {
        success: false,
        error: `A pending approval already exists for "${params.configKey}". It must be resolved before requesting another change.`,
      };
    }

    const { data, error } = await (supabase
      .from("config_pending_approvals" as never)
      .insert({
        config_key: params.configKey,
        current_value: JSON.stringify(params.currentValue),
        proposed_value: JSON.stringify(params.proposedValue),
        requested_by: params.requestedBy,
        change_comment: params.changeComment,
        impact_summary: params.impactSummary ?? null,
      } as never)
      .select(APPROVAL_COLUMNS)
      .single() as unknown as Promise<{
      data: ApprovalRow | null;
      error: { message: string } | null;
    }>);

    if (error || !data) {
      return {
        success: false,
        error: error?.message ?? "Failed to create approval request",
      };
    }

    return { success: true, record: mapApprovalRow(data) };
  } catch (err) {
    logger.error("Approval request failed", {
      configKey: params.configKey,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/config-approval",
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Approve a pending change.
 * Self-approval is blocked — reviewerId must differ from requestedBy.
 * Returns the updated record.
 */
export async function approveChange(
  approvalId: string,
  reviewerId: string,
  reviewComment: string
): Promise<{ success: boolean; record?: ConfigApprovalRecord; error?: string }> {
  return reviewChange(approvalId, reviewerId, reviewComment, "approved");
}

/**
 * Reject a pending change.
 * Returns the updated record.
 */
export async function rejectChange(
  approvalId: string,
  reviewerId: string,
  reviewComment: string
): Promise<{ success: boolean; record?: ConfigApprovalRecord; error?: string }> {
  return reviewChange(approvalId, reviewerId, reviewComment, "rejected");
}

/**
 * Internal: approve or reject a pending change.
 */
async function reviewChange(
  approvalId: string,
  reviewerId: string,
  reviewComment: string,
  newStatus: "approved" | "rejected"
): Promise<{ success: boolean; record?: ConfigApprovalRecord; error?: string }> {
  try {
    const supabase = getSupabaseServiceClient();

    // Fetch the pending approval
    const { data: current } = await (supabase
      .from("config_pending_approvals" as never)
      .select(APPROVAL_COLUMNS)
      .eq("id", approvalId)
      .single() as unknown as Promise<{
      data: ApprovalRow | null;
      error: { message: string } | null;
    }>);

    if (!current) {
      return { success: false, error: `Approval "${approvalId}" not found.` };
    }

    if (current.status !== "pending") {
      return {
        success: false,
        error: `Approval is already ${current.status}. Only pending approvals can be reviewed.`,
      };
    }

    // Check expiry
    if (new Date(current.expires_at) < new Date()) {
      // Mark as expired
      await supabase
        .from("config_pending_approvals" as never)
        .update({ status: "expired" } as never)
        .eq("id", approvalId);
      return {
        success: false,
        error: "This approval has expired.",
      };
    }

    // Block self-approval
    if (newStatus === "approved" && current.requested_by === reviewerId) {
      return {
        success: false,
        error:
          "Self-approval is not permitted. A different super_admin must review this change.",
      };
    }

    // A4: Conditional UPDATE — only updates if status is still 'pending'.
    // Prevents TOCTOU race where two admins approve simultaneously.
    // If another admin already changed the status between our SELECT
    // and this UPDATE, the WHERE clause won't match and we'll get
    // no rows back, which we detect as a conflict.
    const { data: updated, error } = await (supabase
      .from("config_pending_approvals" as never)
      .update({
        status: newStatus,
        reviewed_by: reviewerId,
        review_comment: reviewComment,
        reviewed_at: new Date().toISOString(),
      } as never)
      .eq("id", approvalId)
      .eq("status", "pending")
      .select(APPROVAL_COLUMNS)
      .single() as unknown as Promise<{
      data: ApprovalRow | null;
      error: { message: string } | null;
    }>);

    if (error || !updated) {
      // If no rows updated, another reviewer got there first
      if (!updated && !error) {
        return {
          success: false,
          error: "This approval was already reviewed by another admin. Please refresh.",
        };
      }
      return {
        success: false,
        error: error?.message ?? "Failed to update approval",
      };
    }

    return { success: true, record: mapApprovalRow(updated) };
  } catch (err) {
    logger.error("Approval review failed", {
      approvalId,
      action: newStatus,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/config-approval",
    });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// Query Operations
// ---------------------------------------------------------------------------

/**
 * List approval records with optional filters.
 */
export async function listApprovals(
  options?: ConfigApprovalQueryOptions
): Promise<ConfigApprovalRecord[]> {
  try {
    const supabase = getSupabaseServiceClient();

    let query = supabase
      .from("config_pending_approvals" as never)
      .select(APPROVAL_COLUMNS)
      .order("created_at", { ascending: false });

    if (options?.status) {
      query = query.eq("status", options.status);
    }
    if (options?.configKey) {
      query = query.eq("config_key", options.configKey);
    }
    if (options?.requestedBy) {
      query = query.eq("requested_by", options.requestedBy);
    }

    const limit = options?.limit ?? 20;
    query = query.limit(limit);

    const { data, error } = (await query) as {
      data: ApprovalRow[] | null;
      error: { message: string } | null;
    };

    if (error || !data) return [];

    return data.map(mapApprovalRow);
  } catch (err) {
    logger.error("Approval list query failed", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/config-approval",
    });
    return [];
  }
}

/**
 * Get a single approval record by ID.
 */
export async function getApproval(
  approvalId: string
): Promise<ConfigApprovalRecord | null> {
  try {
    const supabase = getSupabaseServiceClient();

    const { data, error } = await (supabase
      .from("config_pending_approvals" as never)
      .select(APPROVAL_COLUMNS)
      .eq("id", approvalId)
      .single() as unknown as Promise<{
      data: ApprovalRow | null;
      error: { message: string } | null;
    }>);

    if (error || !data) return null;

    return mapApprovalRow(data);
  } catch {
    return null;
  }
}

/**
 * Count pending approvals. Used for the admin dashboard badge.
 */
export async function countPendingApprovals(): Promise<number> {
  try {
    const supabase = getSupabaseServiceClient();

    const { data, error } = await (supabase
      .from("config_pending_approvals" as never)
      .select("id")
      .eq("status", "pending") as unknown as Promise<{
      data: Array<{ id: string }> | null;
      error: { message: string } | null;
    }>);

    if (error || !data) return 0;

    return data.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. isApprovalRequired() reads from platform_config via getConfig(), which
//    has a 60s cache. HOWEVER: both setConfig() and setConfigWithHistory()
//    call cache.delete(key) on write, so changes through the platform's own
//    API take effect immediately. The 60s window only applies to direct DB
//    changes (e.g., Supabase dashboard, migration scripts). If immediate
//    effect is needed after a direct DB change, call clearConfigCache().
//
// 2. Self-approval check compares requested_by === reviewerId as strings.
//    Both must be the same UUID format (from Cognito/auth). If one is null
//    (system request), self-approval check is skipped.
//
// 3. Expired approvals are lazily detected — the status is updated to
//    "expired" only when someone tries to review them. A cron job
//    to expire stale approvals is a future enhancement (TASK-036).
//
// 4. The approval workflow does NOT apply the config change on approval.
//    The caller (config-handlers.ts) is responsible for calling
//    setConfigWithHistory() after receiving an "approved" response.
//    This keeps the approval service focused on workflow, not mutation.
