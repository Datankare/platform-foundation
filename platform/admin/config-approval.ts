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

import {
  alertWaitingUndecided,
  approvalExpiryDays,
  expireLapsedApprovedHolds,
  expireUndecidedHolds,
  recoverStaleRuns,
  RUN_LEASE_SECONDS,
  type SweepScope,
} from "@/platform/admin/hold-expiry";
import { withOwnerTx, withTenantTx, type Tx } from "@/platform/data";
import { logger } from "@/lib/logger";
import type { ErrorCode } from "@/platform/errors/registry";
import { writeFailureCode, type IncompleteWrite } from "@/platform/admin/write-failure";
import { getConfigOrThrow } from "@/platform/auth/platform-config";
import type {
  ConfigApprovalRecord,
  ConfigApprovalStatus,
  ConfigApprovalQueryOptions,
  ConfigApprovalAction,
  ConfigScope,
} from "./types";
import { sameId } from "@/platform/auth/same-id";
import { requiredJobWithdrawalNote } from "@/platform/jobs/required-schedule";

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

/** An approved change to the key is not yet known to be applied (round 17, I-2). */
const SETTLING = Symbol("settling");

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
}): Promise<ConfigApprovalResult> {
  try {
    const outcome = await withTenantTx(async (tx) => {
      // One open request per key and scope in a tenant: serialise concurrent requests for the
      // same key so two cannot both see "none pending" and both insert. The lock is the
      // tenant's own — another tenant changing the same key never waits on it.
      const scope = params.scope ?? "platform";
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 49))", [
        `config-approval:${tx.tenantId ?? "-"}:${scope}:${params.configKey}`,
      ]);
      // Open: pending, or approved and not yet known to be applied (round 16, R-d — an apply
      // that lost its commit, or one not marked applied, is settled by the apply recovery; a
      // second change filed beside it could be applied on top of it, or under it).
      const existing = await tx.query<{ status: string }>(
        `select status::text as status from config_pending_approvals
          where config_key = $1 and scope = $2
            and (status = 'pending' or (status = 'approved' and applied_at is null))
          order by (status = 'pending') desc
          limit 1`,
        [params.configKey, scope]
      );
      if (existing.rowCount > 0)
        return existing.rows[0]?.status === "pending" ? null : SETTLING;
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

    if (outcome === SETTLING) {
      // Its own code (round 17, I-2): no one can decide it — the approval-expiry job settles it.
      const { settlesWithinMinutes } = await import("@/platform/admin/approval-settle");
      return {
        success: false,
        error: `An approved change to "${params.configKey}" is being settled.`,
        errorCode: "approvals.settling",
        errorParams: {
          key: params.configKey,
          minutes: await settlesWithinMinutes(APPLY_LEASE_SECONDS),
        },
      };
    }
    if (outcome === null) {
      return {
        success: false,
        error: `A pending approval already exists for "${params.configKey}". It must be resolved before requesting another change.`,
        // Coded (TASK-194 round 13, I-C): the one waiting must be decided first.
        errorCode: "approvals.already_pending",
        errorParams: { key: params.configKey },
      };
    }
    return { success: true, record: mapApprovalRow(outcome) };
  } catch (err) {
    logger.error("Approval request failed", {
      configKey: params.configKey,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/config-approval",
    });
    // Fixed text (round 14, item 12): the error's own message — a table, a constraint — is
    // logged above, never returned.
    return {
      success: false,
      error: "The approval store is unavailable.",
      errorCode: "service.unavailable",
      errorParams: { service: "config" },
    };
  }
}

/** Result of reviewing an approval; `errorCode` (ADR-051) is what a route returns. */
export interface ConfigApprovalResult {
  success: boolean;
  record?: ConfigApprovalRecord;
  error?: string;
  errorCode?: ErrorCode;
  errorParams?: Record<string, string | number | readonly string[]>;
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

/** Who withdraws an approved change that will not be applied (stale, or a value refused). */
export const APPLY_WITHDRAWAL_ACTOR = "system:approval-apply";

/**
 * What became of an approval whose apply failed, for the screen (TASK-194 round 16, items 3–4):
 * `withdrawn` — closed by the system (stale, or a value its entry refuses): the requester asks
 * again; `settling` — approved and not yet known to be applied (a lost commit, or a withdrawal
 * that could not be written): the apply recovery settles it within APPLY_LEASE_SECONDS plus the
 * job's interval. Neither: reopened, listed again to be decided.
 */
export interface ApplyFailureOutcome {
  readonly applyError?: string;
  readonly withdrawn?: true;
  readonly settling?: true;
}

/**
 * Approve a pending change and apply it, as one outcome (release review, Sprint 7X). When the
 * change cannot be applied, what becomes of the approval follows why (round 15, P-1; round 16,
 * items 3–4): a lost commit is left approved and unapplied, to settle; a stale change or a value
 * its entry refuses is withdrawn by the system, recorded; anything else is reopened (back to
 * pending, reviewer cleared). The reviewer is checked against the key's own tier by the caller.
 */
export async function approveAndApply(
  approvalId: string,
  reviewerId: string,
  reviewComment: string,
  apply: (
    record: ConfigApprovalRecord
  ) => Promise<{ success: boolean; stale?: boolean } & IncompleteWrite>
): Promise<ConfigApprovalResult & ApplyFailureOutcome> {
  const approved = await approveChange(approvalId, reviewerId, reviewComment);
  if (!approved.success || !approved.record) return approved;
  const record = approved.record;
  const applied = await apply(record);
  if (applied.success) {
    await markApplied(approvalId);
    return approved;
  }

  // The value it replaces changed since it was requested (review 12 H2): nothing was applied, and
  // the approval is withdrawn when the withdrawal lands (else left settling, for the approval-
  // expiry job) — never reopened to be approved onto a value it was not judged against. The
  // requester asks again. (The decision itself is audited by its caller.)
  if (applied.stale) {
    const withdrawn = await withdrawUnapplied(record, "stale");
    return {
      success: false,
      error: applied.error ?? "The setting changed since this change was requested.",
      errorCode: "approvals.stale",
      applyError: applied.error,
      ...(withdrawn ? { withdrawn: true as const } : { settling: true as const }),
    };
  }

  // Coded as every config write is (round 15, P-1: write-failure.ts — it answered
  // service.unavailable {config} for every failure); its text is logged, never returned.
  const key = record.configKey;
  const failure = writeFailureCode(key, applied);
  logger.error("Approved change could not be applied", {
    approvalId,
    code: failure.code,
    error: applied.error,
    route: "platform/admin/config-approval",
  });
  const answer = {
    success: false,
    error: "Approved but not applied.",
    errorCode: failure.code,
    errorParams: { ...failure.params },
    applyError: applied.error,
  };

  // A lost commit may have applied (review 14 L-2): never reopened — approving it again would
  // apply it twice. It stays approved and unapplied, the TASK-193 state for "may have applied":
  // once its apply lease has passed, recoverUnappliedApprovals reads the change's own history
  // and marks it applied, or reopens it.
  if (applied.indeterminate) return { ...answer, settling: true };

  // A value its entry now refuses (its range or list changed since it was requested), or a
  // required job's setting turned off or set for a tenant (round 19, I-1: filed before the job
  // was required): withdrawn when the withdrawal lands (else left settling), as a stale one is —
  // reopened, it would only fail the same way when approved again.
  if (
    failure.code === "admin.config_invalid_value" ||
    failure.code === "jobs.schedule_required"
  ) {
    const withdrawn = await withdrawUnapplied(record, "refused", failure.code);
    return withdrawn ? { ...answer, withdrawn: true } : { ...answer, settling: true };
  }

  // Nothing changed (the audit log unavailable, a scope refused, a failed write): reopened, to
  // be listed and decided again.
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
  return answer;
}

/**
 * Withdraw an approved change that will not be applied — stale, or a value its entry refuses
 * (round 16, item 3) — by the system: the row (no reviewer: it is not the approver's rejection;
 * the note names the system and who had approved it) and its audit record (approval_withdrawn,
 * `reason`) in one transaction — no record, no withdrawal. Whether it was withdrawn; when not, it
 * stays approved and unapplied, and the apply recovery reopens it (its history shows no write).
 */
async function withdrawUnapplied(
  record: ConfigApprovalRecord,
  reason: "stale" | "refused",
  /** Why it is refused (round 20, nit 2): a required job's key is noted as 062 notes it. */
  code?: ErrorCode
): Promise<boolean> {
  try {
    const { recordAudit } = await import("@/platform/auth/audit");
    return await withTenantTx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `update config_pending_approvals
            set status = 'rejected', reviewed_by = null, review_comment = $2
          where id = $1::uuid and status = 'approved'
          returning id`,
        [
          record.id,
          `${
            code === "jobs.schedule_required"
              ? `withdrawn by the system: ${requiredJobWithdrawalNote(record.configKey)}`
              : `withdrawn by the system: ${
                  reason === "stale"
                    ? `stale — "${record.configKey}" changed since it was requested`
                    : `refused — "${record.configKey}" no longer takes the value requested`
                }`
          } (approved by ${record.reviewedBy ?? "unknown"} at ${record.reviewedAt ?? "unknown"})`,
        ]
      );
      if (!rows.length) return false;
      await recordAudit({
        action: "admin_action",
        agent: APPLY_WITHDRAWAL_ACTOR,
        details: {
          type: "approval_withdrawn",
          // The parameter's literal union: a code, never free text (audit-details' rule).
          reason,
          source: "config-approval",
          holdIds: [record.id],
          key: record.configKey,
          scope: record.scope,
          ...(record.reviewedBy ? { approvedBy: record.reviewedBy } : {}),
          ...(record.reviewedAt ? { approvedAt: record.reviewedAt } : {}),
        },
      });
      return true;
    });
  } catch (err) {
    logger.error("An approval that will not be applied could not be withdrawn", {
      approvalId: record.id,
      reason,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/config-approval",
    });
    return false;
  }
}

/**
 * Record that an approved change was applied (TASK-193, audit B-9). Best effort: an approval left
 * without it is found by recoverUnappliedApprovals, which reads the change's own history record.
 */
async function markApplied(approvalId: string): Promise<void> {
  // Tried twice (round 17, I-2): unmarked, the row blocks new requests for its key
  // (approvals.settling) until the apply recovery finds the change in its history and marks it —
  // the way out, within APPLY_LEASE_SECONDS plus the job's interval (the job is required: it
  // always runs — round 18).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await withTenantTx((tx) =>
        tx.query(
          "update config_pending_approvals set applied_at = now() where id = $1::uuid and status = 'approved' and applied_at is null",
          [approvalId]
        )
      );
      return;
    } catch (err) {
      logger.warn(
        attempt === 1
          ? "An applied approval could not be marked applied; trying once more"
          : "An applied approval could not be marked applied; the apply recovery will",
        {
          approvalId,
          error: err instanceof Error ? err.message : String(err),
          route: "platform/admin/config-approval",
        }
      );
    }
  }
}

/** How long an approval may stay approved and unapplied before the job looks at it (B-9). */
export const APPLY_LEASE_SECONDS = 600;

/** Who recovers an approval approved and never marked applied. */
export const APPLY_RECOVERY_ACTOR = "system:approval-apply-recovery";

/**
 * Every configuration approval approved more than `leaseSeconds` ago and never marked applied
 * (TASK-193, audit B-9: approve and apply are two transactions, so a crash between them left an
 * approved, unapplied change listed nowhere — the enum has no state past approved): when the
 * change's history shows the reviewer's write of exactly this change since the approval (key,
 * scope, tenant, the value replaced and the value written — review round 1), it was applied — marked so;
 * otherwise it was not — reopened (pending, reviewer cleared), as an apply failure does, so it is
 * listed again and expires on its own date. On the owner connection (the job), every tenant's (or
 * `scope`'s); each recovery recorded in its tenant's audit log in the same statement.
 */
export async function recoverUnappliedApprovals(
  tx: Tx,
  leaseSeconds: number = APPLY_LEASE_SECONDS,
  scope?: SweepScope & { readonly platform?: boolean }
): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `with stuck as (
       select a.tenant_id, a.id, a.config_key,
              -- The change itself (round 1): the same key, scope and tenant, written by the
              -- reviewer after the approval, from the value it was requested against to the value
              -- approved (a reset's: the default it inherits) — never just any write of the key.
              exists (select 1 from platform_config_history h
                       where h.config_key = a.config_key
                         and h.changed_by = a.reviewed_by
                         and h.created_at >= a.reviewed_at
                         and h.tenant_id is not distinct from a.tenant_id
                         and h.scope = case when a.action = 'reset' then 'tenant' else a.scope end
                         and coalesce(h.new_value, 'null'::jsonb) = coalesce(a.proposed_value, 'null'::jsonb)
                         and coalesce(h.previous_value, 'null'::jsonb) = coalesce(a.current_value, 'null'::jsonb)) as applied
         from config_pending_approvals a
        where a.status = 'approved' and a.applied_at is null
          and a.reviewed_at < now() - make_interval(secs => $1::int)
          and ($3::uuid[] is null or a.tenant_id = any($3::uuid[])
               or ($4::boolean and a.tenant_id is null))
        for update of a
     ),
     recovered as (
       update config_pending_approvals a
          set applied_at = case when s.applied then now() else null end,
              status = case when s.applied then a.status else 'pending'::config_approval_status end,
              reviewed_by = case when s.applied then a.reviewed_by else null end,
              review_comment = case when s.applied then a.review_comment else null end,
              reviewed_at = case when s.applied then a.reviewed_at else null end
         from stuck s
        where a.id = s.id and a.status = 'approved' and a.applied_at is null
        returning a.tenant_id, a.id, a.config_key, s.applied
     ),
     audit as (
       insert into audit_log (tenant_id, action, details)
       select r.tenant_id, 'admin_action'::audit_action,
              jsonb_build_object('type', 'approval_apply_recovered', 'holdId', r.id,
                                 'source', 'config-approval', 'key', r.config_key,
                                 'status', case when r.applied then 'applied' else 'reopened' end,
                                 'agent', $2::text, 'outcome', 'succeeded')
         from recovered r
        where r.tenant_id is not null
     )
     select count(*)::int as n from recovered`,
    [
      leaseSeconds,
      APPLY_RECOVERY_ACTOR,
      scope?.tenantIds ?? null,
      scope?.platform === true,
    ]
  );
  return rows[0]?.n ?? 0;
}

/** Pending approvals withdrawn per statement and audit record (review 13 L7). */
export const APPROVAL_WITHDRAWAL_BATCH = 100;
/** The most batches one call withdraws; the rest refuse stale when approved. */
export const APPROVAL_WITHDRAWAL_MAX_BATCHES = 20;

/**
 * Withdraw every pending approval of `configKey` of `scope` in the current tenant (review 12 H2;
 * review 13 L1 — a tenant-scope reduction withdraws only tenant-scope approvals, a platform-scope
 * one only platform-scope approvals): the kill switch or a power reduction changed the key, and
 * each was requested against the value it held before. In batches (review 13 L7): each batch is
 * one update and one audit record (approval_withdrawn, reason "superseded", `holdIds`) in one
 * transaction — no record, no withdrawal — at most APPROVAL_WITHDRAWAL_MAX_BATCHES of them.
 * `actorId` is who reduced the key (a users.id, else recorded as an agent). Returns the ids
 * withdrawn, and whether any were left — and how many (`remaining`).
 *
 * An approval row a concurrent reviewer holds (approveChange's `for update`) is skipped (`skip
 * locked`), never waited on. So after the batches the pending approvals of the key and scope that
 * were requested before the withdrawal began are ALWAYS counted (review 14 L-3: a skipped row was
 * left pending and unreported): any left is `incomplete` (the caller alerts
 * `approvals.withdrawal_incomplete`). A row left pending is still safe: its approval applies only
 * onto the value it was requested against (compare-and-set, stale-change.ts) and refuses as
 * `approvals.stale` — the reduction cannot be undone by it.
 *
 * In the current tenant only: hold-withdrawal.ts runs it in every tenant holding platform-scope
 * approvals of the key (review 14 L-4).
 */
export async function withdrawPendingApprovalsForKey(
  configKey: string,
  actorId: string,
  note: string,
  cause: string,
  scope: ConfigScope
): Promise<{ withdrawn: string[]; incomplete: boolean; remaining: number }> {
  const isUser = UUID.test(actorId);
  const { recordAudit } = await import("@/platform/auth/audit");
  const withdrawn: string[] = [];
  // What "left" means: requested before the withdrawal began — one requested since was requested
  // against the reduced value, and stands.
  const { rows: began } = await withTenantTx((tx) =>
    tx.query<{ at: string }>("select clock_timestamp()::text as at")
  );
  const startedAt = began[0]?.at ?? null;
  for (let batch = 0; batch < APPROVAL_WITHDRAWAL_MAX_BATCHES; batch++) {
    const ids = await withTenantTx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `update config_pending_approvals
            set status = 'rejected', reviewed_by = $2::uuid, review_comment = $3, reviewed_at = now()
          where id in (select id from config_pending_approvals
                        where config_key = $1 and status = 'pending' and scope = $4
                        order by created_at
                        limit $5::int
                        for update skip locked)
          returning id`,
        [
          configKey,
          isUser ? actorId : null,
          note.slice(0, 1000),
          scope,
          APPROVAL_WITHDRAWAL_BATCH,
        ]
      );
      if (rows.length) {
        await recordAudit({
          action: "admin_action",
          ...(isUser ? { actorId } : { agent: actorId }),
          details: {
            type: "approval_withdrawn",
            reason: "superseded",
            cause: cause.slice(0, 500),
            holdIds: rows.map((r) => r.id),
            source: "config-approval",
            key: configKey,
            scope,
            count: rows.length,
          },
        });
      }
      return rows.map((r) => r.id);
    });
    withdrawn.push(...ids);
    if (ids.length < APPROVAL_WITHDRAWAL_BATCH) break;
  }
  // Always (review 14 L-3): the bound reached, or rows skipped as locked — is anything left?
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ n: number | string }>(
      `select count(*)::int as n from config_pending_approvals
        where config_key = $1 and status = 'pending' and scope = $2
          and ($3::timestamptz is null or created_at <= $3::timestamptz)`,
      [configKey, scope, startedAt]
    )
  );
  const remaining = Number(rows[0]?.n ?? 0) || 0;
  return { withdrawn, incomplete: remaining > 0, remaining };
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
      if (newStatus === "approved" && sameId(current.requested_by, reviewerId)) {
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
    // Fixed text (round 14, item 12): the error's own message — a table, a constraint — is
    // logged above, never returned.
    return {
      success: false,
      error: "The approval store is unavailable.",
      errorCode: "service.unavailable",
      errorParams: { service: "config" },
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
 * Mark every pending approval past its expiry as expired — each tenant's, and any with no tenant
 * (none the code files: every approval carries the tenant that filed it, a shared deployment's
 * platform-default one the operator's; one made by hand) — and withdraw every runtime hold
 * approved but never run within the same period (platform/admin/hold-expiry.ts, review 7 M7), so
 * no list keeps offering a decision that would be refused (TASK-036). Returns the count expired.
 * A platform job: the owner connection, from the runner only, never a request.
 *
 * `scope` is for tests (review 11 L-5): only those tenants' rows — and those with no tenant when
 * `platform` is set — so a test's run does not sweep a parallel test's rows. The job passes none.
 *
 * @scheduled config.expire-approvals
 */
export async function expireStaleApprovals(
  scope?: SweepScope & { readonly platform?: boolean }
): Promise<number> {
  const days = await approvalExpiryDays();
  return withOwnerTx("platform-job", async (tx) => {
    // Approved and never applied (TASK-193, audit B-9): marked applied, or reopened — before the
    // expiry below, so a reopened one past its date expires in the same pass.
    const reopened = await recoverUnappliedApprovals(tx, APPLY_LEASE_SECONDS, scope);
    const { rowCount } = await tx.query(
      `update config_pending_approvals set status = 'expired'
        where status = 'pending' and expires_at < now()
          and ($1::uuid[] is null or tenant_id = any($1::uuid[])
               or ($2::boolean and tenant_id is null))`,
      [scope?.tenantIds ?? null, scope?.platform === true]
    );
    // A run that never ended is taken back: executed when its step was recorded, approved again
    // when it was atomic, else undecided (review 10 H2, review 11 H-1) — before the lapse check,
    // so an approval given back past its period lapses in the same pass.
    const recovered = await recoverStaleRuns(tx, RUN_LEASE_SECONDS, scope ?? {});
    // And every runtime hold approved but never run past the same period (review 7 M7), and
    // every one never decided (TASK-193, audit B-4) — each with its trajectory.
    const lapsed = await expireLapsedApprovedHolds(tx, days, scope ?? {});
    const undecided = await expireUndecidedHolds(tx, days, scope ?? {});
    // Undecided runs wait for a person: alerted again on every run while any is waiting.
    await alertWaitingUndecided(tx, scope ?? {});
    return rowCount + reopened + recovered + lapsed + undecided;
  });
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
