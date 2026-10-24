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
 * Approvals belong to the tenant they were requested in (row-level security, ADR-053 D4): a
 * tenant's administrators see and decide only their own. Each records its scope — the platform
 * default or the tenant's own value — which decides how the approved change is applied
 * (config-scope.ts).
 *
 * GenAI Principles:
 *   P10 — Human oversight: two humans must agree on safety-critical changes
 *   P3  — Total observability: every approval action logged
 *   P11 — Resilient degradation: if approval check fails, fail-closed (require approval)
 *   P13 — Control plane: approval requirement is itself a config flag
 *
 * @module platform/admin
 */

import { withOwnerTx, withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import type { ErrorCode } from "@/platform/errors/registry";
import { getConfigOrThrow } from "@/platform/auth/platform-config";
import type {
  ConfigApprovalRecord,
  ConfigApprovalStatus,
  ConfigApprovalQueryOptions,
  ConfigApprovalAction,
  ConfigScope,
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
  reviewed_at: Date | string | null;
  expires_at: Date | string;
  created_at: Date | string;
  scope: string;
  action: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
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
    reviewedAt: row.reviewed_at === null ? null : iso(row.reviewed_at),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    scope: row.scope === "tenant" ? "tenant" : "platform",
    action: row.action === "reset" ? "reset" : "set",
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
    // getConfigOrThrow, not getConfig: a default of false made a missing or unreadable flag
    // switch two-person approval off — the opposite of what this function promises.
    const value = await getConfigOrThrow<unknown>("config.require_two_person_approval");
    return value !== false;
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
  /** What the change is to; default the platform default (single-tenant deployments). */
  scope?: ConfigScope;
  /** "reset": the tenant's own value is removed when approved (scope "tenant" only). */
  action?: ConfigApprovalAction;
}): Promise<{ success: boolean; record?: ConfigApprovalRecord; error?: string }> {
  try {
    const outcome = await withTenantTx(async (tx) => {
      // One open request per key and scope in a tenant: serialise concurrent requests for the
      // same key so two cannot both see "none pending" and both insert. The lock is the
      // tenant's own — another tenant changing the same key never waits on it.
      const scope = params.scope ?? "platform";
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 49))", [
        `config-approval:${tx.tenantId ?? "-"}:${scope}:${params.configKey}`,
      ]);
      const existing = await tx.query(
        "select 1 from config_pending_approvals where config_key = $1 and scope = $2 and status = 'pending' limit 1",
        [params.configKey, scope]
      );
      if (existing.rowCount > 0) return null;
      const { rows } = await tx.query<ApprovalRow>(
        `insert into config_pending_approvals
           (config_key, current_value, proposed_value, requested_by, change_comment, impact_summary, scope, action)
         values ($1, $2::jsonb, $3::jsonb, $4::uuid, $5, $6, $7, $8)
         returning id, config_key, current_value, proposed_value, requested_by, change_comment, impact_summary, status, reviewed_by, review_comment, reviewed_at, expires_at, created_at, scope, action`,
        [
          params.configKey,
          // jsonb columns take the value itself (release review, Sprint 7X: a stringified value
          // was applied as text).
          JSON.stringify(params.currentValue ?? null),
          JSON.stringify(params.proposedValue ?? null),
          params.requestedBy,
          params.changeComment,
          params.impactSummary ?? null,
          scope,
          params.action ?? "set",
        ]
      );
      return rows[0] ?? null;
    });

    if (outcome === null) {
      return {
        success: false,
        error: `A pending approval already exists for "${params.configKey}". It must be resolved before requesting another change.`,
      };
    }
    return { success: true, record: mapApprovalRow(outcome) };
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

/** Result of reviewing an approval; `errorCode` (ADR-051) is what a route returns. */
export interface ConfigApprovalResult {
  success: boolean;
  record?: ConfigApprovalRecord;
  error?: string;
  errorCode?: ErrorCode;
  errorParams?: Record<string, string | number>;
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
): Promise<ConfigApprovalResult> {
  return reviewChange(approvalId, reviewerId, reviewComment, "approved");
}

/**
 * Approve a pending change and apply it, as one outcome (release review, Sprint 7X): if the
 * change cannot be applied, the approval is reopened (back to pending, reviewer cleared), so an
 * approved change is never left unapplied and unable to be approved again. The reviewer is
 * checked against the key's own tier by the caller.
 */
export async function approveAndApply(
  approvalId: string,
  reviewerId: string,
  reviewComment: string,
  apply: (record: ConfigApprovalRecord) => Promise<{ success: boolean; error?: string }>
): Promise<ConfigApprovalResult & { applyError?: string }> {
  const approved = await approveChange(approvalId, reviewerId, reviewComment);
  if (!approved.success || !approved.record) return approved;
  const applied = await apply(approved.record);
  if (applied.success) return approved;

  try {
    await withTenantTx((tx) =>
      tx.query(
        `update config_pending_approvals
            set status = 'pending', reviewed_by = null, review_comment = null, reviewed_at = null
          where id = $1::uuid and status = 'approved'`,
        [approvalId]
      )
    );
  } catch (err) {
    logger.error(
      "Approved change could not be applied, and the approval could not be reopened",
      {
        approvalId,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/admin/config-approval",
      }
    );
  }
  return {
    success: false,
    error: `Approved but not applied: ${applied.error ?? "unknown error"}`,
    errorCode: "service.unavailable",
    errorParams: { service: "config" },
    applyError: applied.error,
  };
}

/**
 * Reject a pending change.
 * Returns the updated record.
 */
export async function rejectChange(
  approvalId: string,
  reviewerId: string,
  reviewComment: string
): Promise<ConfigApprovalResult> {
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
): Promise<ConfigApprovalResult> {
  if (!UUID.test(approvalId)) {
    return {
      success: false,
      error: `Approval "${approvalId}" not found.`,
      errorCode: "approvals.hold_not_found",
    };
  }
  try {
    return await withTenantTx(async (tx): Promise<ConfigApprovalResult> => {
      // Locked for the decision: two reviewers at once serialise here, and the second sees
      // the first's outcome (A4).
      const { rows } = await tx.query<ApprovalRow>(
        `select id, config_key, current_value, proposed_value, requested_by, change_comment, impact_summary, status, reviewed_by, review_comment, reviewed_at, expires_at, created_at, scope, action
           from config_pending_approvals where id = $1::uuid for update`,
        [approvalId]
      );
      const current = rows[0];
      if (!current) {
        return {
          success: false,
          error: `Approval "${approvalId}" not found.`,
          errorCode: "approvals.hold_not_found",
        };
      }
      if (current.status !== "pending") {
        return {
          success: false,
          error: `Approval is already ${current.status}. Only pending approvals can be reviewed.`,
          errorCode: "approvals.decision_conflict",
        };
      }
      if (new Date(current.expires_at) < new Date()) {
        await tx.query(
          "update config_pending_approvals set status = 'expired' where id = $1::uuid and status = 'pending'",
          [approvalId]
        );
        return {
          success: false,
          error: "This approval has expired.",
          errorCode: "approvals.expired",
        };
      }
      if (newStatus === "approved" && current.requested_by === reviewerId) {
        return {
          success: false,
          error:
            "Self-approval is not permitted. A different super_admin must review this change.",
          errorCode: "approvals.self_approval",
        };
      }
      const updated = await tx.query<ApprovalRow>(
        `update config_pending_approvals
            set status = $2::config_approval_status, reviewed_by = $3::uuid,
                review_comment = $4, reviewed_at = now()
          where id = $1::uuid and status = 'pending'
          returning id, config_key, current_value, proposed_value, requested_by, change_comment, impact_summary, status, reviewed_by, review_comment, reviewed_at, expires_at, created_at, scope, action`,
        [approvalId, newStatus, reviewerId, reviewComment]
      );
      if (!updated.rows[0]) {
        return {
          success: false,
          error: "This approval was already reviewed by another admin. Please refresh.",
          errorCode: "approvals.decision_conflict",
        };
      }
      return { success: true, record: mapApprovalRow(updated.rows[0]) };
    });
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Query Operations
// ---------------------------------------------------------------------------

/**
 * List the current tenant's approval records with optional filters.
 */
export async function listApprovals(
  options?: ConfigApprovalQueryOptions
): Promise<ConfigApprovalRecord[]> {
  const limit = Math.min(Math.max(Math.floor(options?.limit ?? 20), 1), 200);
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<ApprovalRow>(
        `select id, config_key, current_value, proposed_value, requested_by, change_comment, impact_summary, status, reviewed_by, review_comment, reviewed_at, expires_at, created_at, scope, action
           from config_pending_approvals
          where ($1::text is null or status = $1::config_approval_status)
            and ($2::text is null or config_key = $2)
            and ($3::uuid is null or requested_by = $3)
          order by created_at desc
          limit $4`,
        [
          options?.status ?? null,
          options?.configKey ?? null,
          options?.requestedBy ?? null,
          limit,
        ]
      )
    );
    return rows.map(mapApprovalRow);
  } catch (err) {
    logger.error("Approval list query failed", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/config-approval",
    });
    return [];
  }
}

/**
 * Get a single approval record by ID (the current tenant's only).
 */
export async function getApproval(
  approvalId: string
): Promise<ConfigApprovalRecord | null> {
  if (!UUID.test(approvalId)) return null;
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<ApprovalRow>(
        `select id, config_key, current_value, proposed_value, requested_by, change_comment, impact_summary, status, reviewed_by, review_comment, reviewed_at, expires_at, created_at, scope, action
           from config_pending_approvals where id = $1::uuid`,
        [approvalId]
      )
    );
    return rows[0] ? mapApprovalRow(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Count the current tenant's pending approvals. Used for the admin dashboard badge.
 */
export async function countPendingApprovals(): Promise<number> {
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from config_pending_approvals where status = 'pending'"
      )
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Mark every pending approval past its expiry as expired — each tenant's and the platform's own
 * (a shared deployment's platform defaults, tenant_id null) — so no list keeps offering a
 * decision that would be refused (TASK-036). Returns the count expired. A platform job: the
 * owner connection, from the runner only, never a request.
 *
 * @scheduled config.expire-approvals
 */
export async function expireStaleApprovals(): Promise<number> {
  const { rowCount } = await withOwnerTx("platform-job", (tx) =>
    tx.query(
      "update config_pending_approvals set status = 'expired' where status = 'pending' and expires_at < now()"
    )
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. isApprovalRequired() reads from platform_config via getConfigOrThrow(), which
//    has a 60s cache. HOWEVER: setConfigWithHistory()
//    calls cache.delete(key) on write, so changes through the platform's own
//    API take effect immediately. The 60s window only applies to direct DB
//    changes (e.g., Supabase dashboard, migration scripts). If immediate
//    effect is needed after a direct DB change, call clearConfigCache().
//
// 2. Self-approval check compares requested_by === reviewerId as strings.
//    Both must be the same UUID format (from Cognito/auth). If one is null
//    (system request), self-approval check is skipped.
//
// 3. Expired approvals are detected when someone tries to review them, and
//    swept by expireStaleApprovals (the config.expire-approvals job, TASK-036)
//    so the pending list does not keep showing what can no longer be decided.
//
// 4. The approval workflow does NOT apply the config change on approval.
//    The caller (config-handlers.ts) is responsible for calling
//    setConfigWithHistory() after receiving an "approved" response.
//    This keeps the approval service focused on workflow, not mutation.
