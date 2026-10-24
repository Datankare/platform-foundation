/**
 * platform/moderation/review-service.ts — Human review business logic
 *
 * ADR-024: Human review queue and appeals.
 * P2: Bounded workflow — submit, claim, resolve.
 * P10: Human oversight as final authority on escalated/appealed decisions.
 * P17: Claim = cognition (reversible); resolve = commitment (durable).
 * L19: Submit is primary function — failures surfaced, not swallowed.
 *
 * Side effects on resolution:
 *   overturn → restore account status, expire related strike, update audit
 *   modify   → adjust strike severity (future)
 *   uphold   → no changes
 *
 * @module platform/moderation
 */

import { logger } from "@/lib/logger";
import { getConfig } from "@/platform/auth/platform-config";
import { withTenantTx, type Tx } from "@/platform/data";
import { audited, AuditWriteError } from "@/platform/auth/audit";
import { getStrikeStore } from "./strikes";
import { getReviewQueueStore } from "./review-store";
import { loadEscalationSlaHours, loadRemedialAction } from "./config";
import type {
  ReviewQueueItem,
  ReviewDecision,
  ReviewItemSource,
  ReviewPriority,
  ReviewQueryOptions,
  ReviewResult,
} from "./review-types";
import type { AccountStatus, ModerationResult, ModerationAction } from "./types";
import type { ExplanationChain } from "@/platform/rag/types";

// ---------------------------------------------------------------------------
// Source → priority (P6: compile-time exhaustive map, not a switch)
// ---------------------------------------------------------------------------

/**
 * Queue priority for each review source. A const Record (rather than a switch)
 * so TypeScript fails the build if a new ReviewItemSource is added without a
 * priority (F4 — Sprint 6 adversarial review, New Hire finding).
 */
const SOURCE_TO_PRIORITY: Record<ReviewItemSource, ReviewPriority> = {
  ban_review: "critical",
  escalation: "high",
  appeal: "normal",
};

// ---------------------------------------------------------------------------
// Configuration loaders (P13)
// ---------------------------------------------------------------------------

/** Hours after a decision during which an appeal can be filed */
async function loadAppealWindowHours(): Promise<number> {
  const hours = await getConfig<number>("moderation.appeal_window_hours", 72);
  return typeof hours === "number" ? hours : 72;
}

/** Hours before an unclaimed review item is released back to pending */
async function loadClaimTimeoutHours(): Promise<number> {
  const hours = await getConfig<number>("moderation.review_claim_timeout_hours", 24);
  return typeof hours === "number" ? hours : 24;
}

/** Minimum characters required for an appeal reason */
async function loadMinReasonLength(): Promise<number> {
  const len = await getConfig<number>("moderation.appeal_reason_min_length", 20);
  return typeof len === "number" ? len : 20;
}

// ---------------------------------------------------------------------------
// Submit for review
// ---------------------------------------------------------------------------

/** Input for submitting a review item */
export interface SubmitReviewInput {
  /** Source: escalation, ban_review, or appeal */
  readonly source: ReviewItemSource;
  /** The moderation result being reviewed */
  readonly moderationResult: ModerationResult;
  /** User whose content triggered the review */
  readonly targetUserId: string;
  /** Request ID for trace correlation */
  readonly requestId: string;
  /** Explanation chain for reviewer context */
  readonly explanationChain?: ExplanationChain;
  /**
   * Account status that existed BEFORE the decision under review. Used to
   * restore the correct status on overturn (F1). Only meaningful for sources
   * that change account status (ban_review); leave undefined for escalations.
   */
  readonly previousAccountStatus?: AccountStatus;
  /**
   * The strike a ban_review actioned, for AUDIT / FORENSICS ONLY (recorded on
   * the review row). NOT the expiry lookup key — see
   * StrikeRecord.guardianDecisionId.
   */
  readonly relatedStrikeId?: string;
}

/**
 * Submit a moderation decision for human review.
 *
 * Called automatically by:
 *   - Middleware when Guardian returns action: "escalate"
 *   - Sentinel when consequence is "ban"
 *
 * Returns the created review item or error.
 */
export async function submitForReview(input: SubmitReviewInput): Promise<ReviewResult> {
  const priority = SOURCE_TO_PRIORITY[input.source];
  const store = getReviewQueueStore();

  return store.submit({
    source: input.source,
    priority,
    status: "pending",
    moderationResult: input.moderationResult,
    targetUserId: input.targetUserId,
    requestId: input.requestId,
    explanationChain: input.explanationChain,
    previousAccountStatus: input.previousAccountStatus,
    relatedStrikeId: input.relatedStrikeId,
  });
}

// ---------------------------------------------------------------------------
// Submit appeal
// ---------------------------------------------------------------------------

/** Input for submitting a user appeal */
export interface SubmitAppealInput {
  /** The moderation trajectory ID being appealed */
  readonly originalDecisionId: string;
  /** The original moderation result */
  readonly moderationResult: ModerationResult;
  /** The user filing the appeal */
  readonly appealingUserId: string;
  /** Why the user believes the decision was wrong */
  readonly appealReason: string;
  /** Request ID for trace correlation */
  readonly requestId: string;
  /**
   * Account status before the appealed decision, when known (e.g. derived from
   * the original Sentinel decision). Used to restore the correct status if the
   * appeal is later overturned (F1).
   */
  readonly previousAccountStatus?: AccountStatus;
}

/**
 * Submit a user appeal against a block or ban decision.
 *
 * Validates:
 *   - Only block or ban decisions can be appealed
 *   - Appeal reason meets minimum length
 *   - No pending appeal exists for the same decision
 *   - Decision is within the appeal window
 *
 * Returns the created review item or a validation error.
 */
export async function submitAppeal(
  input: SubmitAppealInput,
  decisionTimestamp: string
): Promise<ReviewResult> {
  // Validate: only a block can be appealed
  if (input.moderationResult.action !== "block") {
    return {
      success: false,
      error: `Only blocked decisions can be appealed, got: ${input.moderationResult.action}`,
      errorCode: "moderation.appeal_not_allowed",
    };
  }

  // Validate: reason minimum length
  const minLength = await loadMinReasonLength();
  if (input.appealReason.trim().length < minLength) {
    return {
      success: false,
      error: `Appeal reason must be at least ${minLength} characters`,
      errorCode: "moderation.appeal_reason_too_short",
      errorParams: { min: minLength },
    };
  }

  // Validate: bounded — the reason reaches a reviewer's screen and the assist prompt.
  if (input.appealReason.length > MAX_APPEAL_REASON_CHARS) {
    return {
      success: false,
      error: `Appeal reason must be at most ${MAX_APPEAL_REASON_CHARS} characters`,
      errorCode: "request.text_too_long",
      errorParams: { max: MAX_APPEAL_REASON_CHARS },
    };
  }

  // Validate: within appeal window
  const windowHours = await loadAppealWindowHours();
  const decisionTime = new Date(decisionTimestamp).getTime();
  const windowMs = windowHours * 60 * 60 * 1000;
  if (Date.now() - decisionTime > windowMs) {
    return {
      success: false,
      error: `Appeal window has expired (${windowHours} hours)`,
      errorCode: "moderation.appeal_window_expired",
      errorParams: { hours: windowHours },
    };
  }

  // Validate: no pending appeal for same decision
  const store = getReviewQueueStore();
  const existing = await store.getByOriginalDecisionId(input.originalDecisionId);
  if (existing) {
    return {
      success: false,
      error: "An appeal is already pending for this decision",
      errorCode: "moderation.appeal_pending",
    };
  }

  return store.submit({
    source: "appeal",
    priority: "normal",
    status: "pending",
    moderationResult: input.moderationResult,
    targetUserId: input.appealingUserId,
    requestId: input.requestId,
    appealReason: input.appealReason,
    originalDecisionId: input.originalDecisionId,
    previousAccountStatus: input.previousAccountStatus,
  });
}

// ---------------------------------------------------------------------------
// Claim item
// ---------------------------------------------------------------------------

/**
 * Claim a review item for review.
 *
 * P17: Claiming is cognition — reversible via unclaim or timeout.
 * Only pending items can be claimed.
 */
export async function claimItem(
  itemId: string,
  reviewerId: string
): Promise<ReviewResult> {
  const store = getReviewQueueStore();
  const item = await store.getById(itemId);

  if (!item) {
    return {
      success: false,
      error: `Review item not found: ${itemId}`,
      errorCode: "moderation.review_item_not_found",
    };
  }
  if (item.status !== "pending") {
    return {
      success: false,
      error: `Item is ${item.status}, not pending`,
      errorCode: "moderation.item_state_conflict",
      errorParams: { status: item.status },
    };
  }
  if (isSelfReview(item, reviewerId)) return SELF_REVIEW;

  // Claimed only if still pending: of two reviewers claiming at once, one wins.
  return store.update(
    itemId,
    { status: "claimed", claimedBy: reviewerId, claimedAt: new Date().toISOString() },
    { status: "pending" }
  );
}

// ---------------------------------------------------------------------------
// Unclaim item
// ---------------------------------------------------------------------------

/**
 * Release a claimed item back to pending.
 * Only the reviewer who claimed it can unclaim it.
 */
export async function unclaimItem(
  itemId: string,
  reviewerId: string
): Promise<ReviewResult> {
  const store = getReviewQueueStore();
  const item = await store.getById(itemId);

  if (!item) {
    return {
      success: false,
      error: `Review item not found: ${itemId}`,
      errorCode: "moderation.review_item_not_found",
    };
  }
  if (item.status !== "claimed") {
    return {
      success: false,
      error: `Item is ${item.status}, not claimed`,
      errorCode: "moderation.item_state_conflict",
      errorParams: { status: item.status },
    };
  }
  if (item.claimedBy !== reviewerId) {
    return {
      success: false,
      error: "Only the claiming reviewer can unclaim",
      errorCode: "moderation.not_claimer",
    };
  }

  // The claim is cleared (null), and only while it is still this reviewer's.
  return store.update(
    itemId,
    { status: "pending", claimedBy: null, claimedAt: null },
    { status: "claimed", claimedBy: reviewerId }
  );
}

// ---------------------------------------------------------------------------
// Resolve item
// ---------------------------------------------------------------------------

/** Input for resolving a review item */
export interface ResolveInput {
  /** The review item ID */
  readonly itemId: string;
  /** The reviewer making the decision */
  readonly reviewerId: string;
  /** The decision: uphold, overturn, or modify */
  readonly decision: ReviewDecision;
  /** Reviewer's notes explaining the decision */
  readonly reviewerNotes: string;
  /** Modified action (required when decision === "modify") */
  readonly modifiedAction?: ModerationAction;
}

/**
 * Resolve a review item with a decision.
 *
 * P17: Resolution is commitment — triggers durable side effects.
 * Only the reviewer who claimed the item can resolve it.
 *
 * Side effects:
 *   overturn → restoreAccountStatus + expire strike
 *   modify   → (future: adjust strike severity)
 *   uphold   → no side effects
 */
export async function resolveItem(input: ResolveInput): Promise<ReviewResult> {
  const store = getReviewQueueStore();
  const item = await store.getById(input.itemId);

  if (!item) {
    return {
      success: false,
      error: `Review item not found: ${input.itemId}`,
      errorCode: "moderation.review_item_not_found",
    };
  }
  if (item.status !== "claimed") {
    return {
      success: false,
      error: `Item is ${item.status}, not claimed`,
      errorCode: "moderation.item_state_conflict",
      errorParams: { status: item.status },
    };
  }
  if (item.claimedBy !== input.reviewerId) {
    return {
      success: false,
      error: "Only the claiming reviewer can resolve",
      errorCode: "moderation.not_claimer",
    };
  }
  if (isSelfReview(item, input.reviewerId)) return SELF_REVIEW;
  if (input.decision === "modify" && !input.modifiedAction) {
    return {
      success: false,
      error: "modifiedAction is required when decision is modify",
      errorCode: "moderation.modified_action_required",
    };
  }

  // Recorded before anything changes; with no record nothing changes (audit X-8). The account
  // and strike are restored before the item is marked resolved, so a failed restoration leaves
  // the item claimed and retryable rather than resolved with the user still banned.
  try {
    return await audited(
      {
        action: "admin_action",
        actorId: input.reviewerId,
        targetId: item.targetUserId,
        details: {
          type: "review_resolution",
          reviewItemId: item.id,
          source: item.source,
          decision: input.decision,
          reviewerNotes: input.reviewerNotes,
          modifiedAction: input.modifiedAction,
          originalAction: item.moderationResult.action,
          trajectoryId: item.moderationResult.trajectoryId,
        },
      },
      async (): Promise<ReviewResult> => {
        if (input.decision === "overturn") {
          const failure = await applyOverturnSideEffects(item, input.reviewerId);
          if (failure)
            return { success: false, error: failure, errorCode: "internal.error" };
        }
        // Resolved only while still claimed by this reviewer: a release or another reviewer's
        // decision in between is a conflict, never a second resolution.
        return store.update(
          input.itemId,
          {
            status: "resolved",
            resolvedBy: input.reviewerId,
            resolvedAt: new Date().toISOString(),
            decision: input.decision,
            reviewerNotes: input.reviewerNotes,
            modifiedAction: input.modifiedAction,
          },
          { status: "claimed", claimedBy: input.reviewerId }
        );
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return {
        success: false,
        error: "The audit log is unavailable, so the decision was not applied.",
        errorCode: "service.unavailable",
        errorParams: { service: "audit" },
      };
    }
    throw err;
  }
}

/** A moderator never reviews a case about their own account (audit X-6). */
function isSelfReview(item: ReviewQueueItem, reviewerId: string): boolean {
  return item.targetUserId === reviewerId;
}

const SELF_REVIEW: ReviewResult = {
  success: false,
  error: "A moderator cannot review a case about their own account",
  errorCode: "moderation.self_review",
};

// ---------------------------------------------------------------------------
// Release expired claims
// ---------------------------------------------------------------------------

/**
 * Release claimed items that have exceeded the timeout.
 * Typically called by a cron job or admin action.
 */
export async function releaseExpiredClaims(): Promise<number> {
  const timeoutHours = await loadClaimTimeoutHours();
  const timeoutMs = timeoutHours * 60 * 60 * 1000;
  return getReviewQueueStore().releaseExpiredClaims(timeoutMs);
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Get the current review queue with optional filters */
export async function getQueue(
  options?: ReviewQueryOptions
): Promise<readonly ReviewQueueItem[]> {
  return getReviewQueueStore().query(options);
}

/** Get queue statistics */
export async function getQueueStats() {
  return getReviewQueueStore().getStats();
}

// ---------------------------------------------------------------------------
// Side effects (internal)
// ---------------------------------------------------------------------------

/**
 * Apply side effects when a decision is overturned:
 *   1. Restore account status to the PRE-DECISION status (escalations excluded)
 *   2. Identify the related strike for expiry
 *
 * F1 (Sprint 6 adversarial review): escalations (Guardian "escalate") never
 * change account status — the content is held, not the account. Overturning an
 * escalation must therefore NOT touch the users table, or an unrelated and still
 * valid status (e.g. "warned" from a separate strike) would be wiped. For
 * status-changing sources we restore the status recorded at submission rather
 * than blanket-resetting to "active".
 */
async function applyOverturnSideEffects(
  item: ReviewQueueItem,
  reviewerId: string
): Promise<string | null> {
  // 1. Restore account status (escalations never changed it).
  if (item.source === "escalation") {
    logger.info("Review: overturn of escalation — account status unchanged", {
      userId: item.targetUserId,
      reviewerId,
      reviewItemId: item.id,
      route: "platform/moderation/review-service",
    });
  } else {
    const failure = await restoreAccountStatus(item, reviewerId);
    if (failure) return failure;
  }

  // 2. Expire the strike caused by the overturned decision.
  //
  // CANONICAL link: the strike's guardianDecisionId equals the Guardian decision
  // the review item carries (item.moderationResult.trajectoryId). This resolves
  // uniformly for every source (ban_review, appeal) because a strike is keyed to
  // the decision that caused it. We deliberately do NOT use item.relatedStrikeId
  // here — that column is AUDIT-ONLY (ADR-024 / migration 020); resolving expiry
  // through it would couple behavior to a denormalized convenience field.
  try {
    const strikeStore = getStrikeStore();
    const strikes = await strikeStore.getActiveStrikes(item.targetUserId);
    const relatedStrike = strikes.find(
      (s) => s.guardianDecisionId === item.moderationResult.trajectoryId
    );
    if (relatedStrike) {
      const expired = await strikeStore.expireStrike(relatedStrike.id);
      logger.info("Review: strike expired on overturn", {
        strikeId: relatedStrike.id,
        expired,
        userId: item.targetUserId,
        reviewerId,
        route: "platform/moderation/review-service",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Review: strike expiry failed", {
      userId: item.targetUserId,
      error: message,
      route: "platform/moderation/review-service",
    });
    return `strike expiry failed: ${message}`;
  }
  return null;
}

/** Longest appeal reason accepted (release review, Sprint 7X). */
export const MAX_APPEAL_REASON_CHARS = 2000;

/** Account statuses, least to most severe. */
const SEVERITY: readonly AccountStatus[] = [
  "active",
  "warned",
  "restricted",
  "suspended",
  "banned",
];

/** The status change recorded for a Guardian decision, newest first among a user's records. */
interface StatusChangeRecord {
  readonly guardianDecisionId?: unknown;
  readonly previousStatus?: unknown;
  readonly newStatus?: unknown;
  readonly outcome?: unknown;
}

/** A restoration that could not be made; the message is the failure returned to the caller. */
class RestoreFailure extends Error {}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The most recent status change applied to an account (Sentinel's `sentinel_status_change`
 * record), or null when there is none. A change whose recorded outcome is "failed" never
 * happened and is skipped. Throws when the records cannot be read (fail closed).
 */
async function latestStatusChange(
  tx: Tx,
  userId: string
): Promise<StatusChangeRecord | null> {
  let rows: { details: Record<string, unknown> | null }[];
  try {
    ({ rows } = await tx.query<{ details: Record<string, unknown> | null }>(
      `select details from audit_log
        where target_id = $1::uuid and action = 'admin_action'
        order by created_at desc
        limit 200`,
      [userId]
    ));
  } catch (err) {
    throw new Error(`status history unreadable: ${errorText(err)}`, { cause: err });
  }
  const changes = rows
    .map((row) => row.details ?? {})
    .filter((d) => d.type === "sentinel_status_change");
  // An attempt whose failure was recorded did not change the account.
  const failed = new Set(
    changes
      .filter((d) => d.outcome === "failed")
      .map((d) => `${String(d.guardianDecisionId)}:${String(d.newStatus)}`)
  );
  return (
    changes.find(
      (d) =>
        d.outcome !== "failed" &&
        !failed.has(`${String(d.guardianDecisionId)}:${String(d.newStatus)}`)
    ) ?? null
  );
}

/**
 * Lift the consequence of an overturned decision — and only that decision's (release review,
 * Sprint 7X). The account is restored only when the overturned decision is the one that set
 * its current status: the latest recorded status change names this decision and its new status
 * is the account's status now. Then it is restored to the status recorded before that change,
 * which must be less severe (an overturn never imposes a consequence, audit X-2). If a later
 * decision set the current status, or no record shows this decision changed the account, the
 * status is left as it is: overturning a warning must not lift a later ban. Returns a failure
 * message, or null.
 *
 * One transaction: the account row is locked (`for update`) while its history is read and the
 * restoration written, so a status change made meanwhile cannot be overwritten.
 */
async function restoreAccountStatus(
  item: ReviewQueueItem,
  reviewerId: string
): Promise<string | null> {
  const decisionId = item.originalDecisionId ?? item.moderationResult.trajectoryId;

  try {
    return await withTenantTx(async (tx): Promise<string | null> => {
      let current: { account_status: AccountStatus } | undefined;
      try {
        ({
          rows: [current],
        } = await tx.query<{ account_status: AccountStatus }>(
          "select account_status from users where id = $1::uuid for update",
          [item.targetUserId]
        ));
      } catch (err) {
        throw new RestoreFailure(`account status unreadable: ${errorText(err)}`);
      }
      if (!current) return "account not found";

      const change = await latestStatusChange(tx, item.targetUserId);
      const inForce =
        change !== null &&
        change.guardianDecisionId === decisionId &&
        change.newStatus === current.account_status &&
        typeof change.previousStatus === "string" &&
        SEVERITY.includes(change.previousStatus as AccountStatus);
      if (!inForce) {
        logger.warn(
          "Review: the overturned decision did not set the account's current status — left unchanged",
          {
            userId: item.targetUserId,
            reviewerId,
            reviewItemId: item.id,
            current: current.account_status,
            route: "platform/moderation/review-service",
          }
        );
        return null;
      }
      const restoreTo = change.previousStatus as AccountStatus;

      const now = SEVERITY.indexOf(current.account_status);
      const to = SEVERITY.indexOf(restoreTo);
      if (to < 0 || to >= now) {
        logger.warn(
          "Review: overturn would not lower the account's status — left unchanged",
          {
            userId: item.targetUserId,
            reviewerId,
            reviewItemId: item.id,
            current: current.account_status,
            recordedPrevious: restoreTo,
            route: "platform/moderation/review-service",
          }
        );
        return null;
      }

      // A ban is lifted; a suspension or restriction end date stays only when restoring into it.
      await tx.query(
        `update users set
            account_status = $2::account_status,
            banned_at = null,
            ban_reason = null,
            status_changed_by = $3,
            status_changed_at = now(),
            suspended_until = case when $2::text = 'suspended' then suspended_until end,
            restricted_until = case when $2::text = 'restricted' then restricted_until end
          where id = $1::uuid`,
        [item.targetUserId, restoreTo, reviewerId]
      );

      logger.info("Review: account status restored on overturn", {
        userId: item.targetUserId,
        reviewerId,
        reviewItemId: item.id,
        source: item.source,
        restoredTo: restoreTo,
        route: "platform/moderation/review-service",
      });
      return null;
    });
  } catch (err) {
    if (err instanceof RestoreFailure) return err.message;
    const message = errorText(err);
    logger.error("Review: account status restoration failed", {
      userId: item.targetUserId,
      reviewerId,
      error: message,
      route: "platform/moderation/review-service",
    });
    return `account status restore failed: ${message}`;
  }
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. F1 — overturn restores to item.previousAccountStatus, NOT unconditionally
//    "active", and only ever to a status LESS severe than the account's current one
//    (X-2): an overturn lifts a consequence, it cannot impose one. Escalations skip
//    status restoration entirely (Guardian "escalate" never changes account status).
//
// 2. previousAccountStatus comes only from producers that own the status change, never
//    from a request body: Sentinel's ban_review submission (SentinelResult.previousStatus)
//    and the appeals route (derived from the original Sentinel audit record). The manual
//    submit route accepts escalations only (Sprint 7X).
//
// 3. Overturn side effects run BEFORE the item is marked resolved; a failure leaves the item
//    claimed and returns the error, so a moderator can retry instead of a resolved item with
//    the user still banned.
//
// 4. submitAppeal accepts only a "block" action. A block is the user-facing
//    punishment a user would contest; "escalate" already routes to human
//    review, and "ban" is a downstream Sentinel consequence of a block, not a
//    ModerationAction. The guard and its error message agree (Sprint 6 follow-up).

// ---------------------------------------------------------------------------
// Escalation SLA reaper (ADR-041 D3)
// ---------------------------------------------------------------------------

/** Outcome of a reaper sweep. */
export interface ReapResult {
  /** Overdue escalation items matched (pending + claimed, older than the SLA). */
  readonly scanned: number;
  /** Items resolved to a block (the secure default remedial). */
  readonly blocked: number;
  /** Items ratcheted to critical priority (escalate_higher remedial). */
  readonly escalatedHigher: number;
  /** SLA (hours) applied this sweep. */
  readonly slaHours: number;
  /** ISO cutoff: items created before this were overdue. */
  readonly cutoff: string;
}

/**
 * Reap over-SLA escalations (ADR-041 D3). Selects source="escalation" items in
 * pending/claimed created before (now - SLA) and applies the configured remedial
 * action - never "allow":
 *   - "block" (secure default): resolve as decision "modify" -> modifiedAction
 *     "block"; the already-withheld content becomes a concrete, appealable block.
 *   - "escalate_higher": ratchet priority to "critical" and keep it queued; items
 *     already at "critical" are skipped (a one-way ratchet, so re-running is safe).
 * Each change is recorded first (agent "escalation-reaper"); an item whose record cannot be
 * written is left for the next sweep. `now` is injectable for deterministic tests.
 */
export async function reapOverdueEscalations(
  now: Date = new Date()
): Promise<ReapResult> {
  const store = getReviewQueueStore();
  const slaHours = await loadEscalationSlaHours();
  const remedial = await loadRemedialAction();
  const cutoff = new Date(now.getTime() - slaHours * 3_600_000).toISOString();

  const overdue = [
    ...(await store.query({ status: "pending", source: "escalation", before: cutoff })),
    ...(await store.query({ status: "claimed", source: "escalation", before: cutoff })),
  ];

  let blocked = 0;
  let escalatedHigher = 0;

  for (const item of overdue) {
    if (remedial === "escalate_higher") {
      if (item.priority === "critical") continue; // one-way ratchet -> idempotent
      const res = await reapAudited(
        {
          action: "admin_action",
          agent: REAPER,
          targetId: item.targetUserId,
          details: {
            type: "escalation_sla_escalate_higher",
            reviewItemId: item.id,
            slaHours,
            trajectoryId: item.moderationResult.trajectoryId,
            reapedAt: now.toISOString(),
          },
        },
        // Only if no reviewer took it meanwhile.
        () =>
          store.update(
            item.id,
            { status: "pending", priority: "critical" },
            { status: item.status }
          )
      );
      if (res.success) escalatedHigher++;
      continue;
    }

    const res = await reapAudited(
      {
        action: "admin_action",
        agent: REAPER,
        targetId: item.targetUserId,
        details: {
          type: "escalation_sla_block",
          reviewItemId: item.id,
          slaHours,
          originalAction: item.moderationResult.action,
          trajectoryId: item.moderationResult.trajectoryId,
          reapedAt: now.toISOString(),
        },
      },
      // Only if no reviewer took it meanwhile: a claimed item is a human's to decide.
      () =>
        store.update(
          item.id,
          {
            status: "resolved",
            decision: "modify",
            modifiedAction: "block",
            resolvedBy: REAPER,
            resolvedAt: now.toISOString(),
            reviewerNotes: `Auto-blocked: escalation exceeded the ${slaHours}h SLA without human review (ADR-041).`,
          },
          { status: item.status }
        )
    );
    if (res.success) blocked++;
  }

  return { scanned: overdue.length, blocked, escalatedHigher, slaHours, cutoff };
}

/** The reaper's name in the audit log and on items it resolves. */
const REAPER = "escalation-reaper";

/** One reaper change under audited(); an unwritable record skips the item (next sweep retries). */
async function reapAudited(
  entry: Parameters<typeof audited>[0],
  act: () => Promise<ReviewResult>
): Promise<ReviewResult> {
  try {
    return await audited(entry, act);
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return {
        success: false,
        error: "audit unavailable",
        errorCode: "service.unavailable",
      };
    }
    throw err;
  }
}
