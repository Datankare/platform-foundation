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
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { getStrikeStore } from "./strikes";
import { getReviewQueueStore } from "./review-store";
import type {
  ReviewQueueItem,
  ReviewDecision,
  ReviewItemSource,
  ReviewPriority,
  ReviewQueryOptions,
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
export async function submitForReview(
  input: SubmitReviewInput
): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
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
): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
  // Validate: only a block can be appealed
  if (input.moderationResult.action !== "block") {
    return {
      success: false,
      error: `Only blocked decisions can be appealed, got: ${input.moderationResult.action}`,
    };
  }

  // Validate: reason minimum length
  const minLength = await loadMinReasonLength();
  if (input.appealReason.trim().length < minLength) {
    return {
      success: false,
      error: `Appeal reason must be at least ${minLength} characters`,
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
    };
  }

  // Validate: no pending appeal for same decision
  const store = getReviewQueueStore();
  const existing = await store.getByOriginalDecisionId(input.originalDecisionId);
  if (existing) {
    return {
      success: false,
      error: "An appeal is already pending for this decision",
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
): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
  const store = getReviewQueueStore();
  const item = await store.getById(itemId);

  if (!item) {
    return { success: false, error: `Review item not found: ${itemId}` };
  }
  if (item.status !== "pending") {
    return {
      success: false,
      error: `Item is ${item.status}, not pending`,
    };
  }

  return store.update(itemId, {
    status: "claimed",
    claimedBy: reviewerId,
    claimedAt: new Date().toISOString(),
  });
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
): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
  const store = getReviewQueueStore();
  const item = await store.getById(itemId);

  if (!item) {
    return { success: false, error: `Review item not found: ${itemId}` };
  }
  if (item.status !== "claimed") {
    return { success: false, error: `Item is ${item.status}, not claimed` };
  }
  if (item.claimedBy !== reviewerId) {
    return {
      success: false,
      error: "Only the claiming reviewer can unclaim",
    };
  }

  return store.update(itemId, {
    status: "pending",
    claimedBy: undefined,
    claimedAt: undefined,
  });
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
export async function resolveItem(
  input: ResolveInput
): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
  const store = getReviewQueueStore();
  const item = await store.getById(input.itemId);

  if (!item) {
    return {
      success: false,
      error: `Review item not found: ${input.itemId}`,
    };
  }
  if (item.status !== "claimed") {
    return {
      success: false,
      error: `Item is ${item.status}, not claimed`,
    };
  }
  if (item.claimedBy !== input.reviewerId) {
    return {
      success: false,
      error: "Only the claiming reviewer can resolve",
    };
  }
  if (input.decision === "modify" && !input.modifiedAction) {
    return {
      success: false,
      error: "modifiedAction is required when decision is modify",
    };
  }

  const now = new Date().toISOString();

  const result = await store.update(input.itemId, {
    status: "resolved",
    resolvedBy: input.reviewerId,
    resolvedAt: now,
    decision: input.decision,
    reviewerNotes: input.reviewerNotes,
    modifiedAction: input.modifiedAction,
  });

  if (!result.success) return result;

  // ── Side effects (commitment) ──────────────────────────────────
  if (input.decision === "overturn") {
    await applyOverturnSideEffects(item, input.reviewerId);
  }

  // Audit log (fire-and-forget)
  writeAuditLog({
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
  });

  return result;
}

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
): Promise<void> {
  // 1. Restore account status (escalations never changed it).
  if (item.source === "escalation") {
    logger.info("Review: overturn of escalation — account status unchanged", {
      userId: item.targetUserId,
      reviewerId,
      reviewItemId: item.id,
      route: "platform/moderation/review-service",
    });
  } else {
    await restoreAccountStatus(item, reviewerId);
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
    logger.error("Review: strike expiry failed", {
      userId: item.targetUserId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/moderation/review-service",
    });
  }
}

/**
 * Restore a user's account status when a status-changing decision is overturned.
 *
 * Restores to `item.previousAccountStatus` when known, otherwise falls back to
 * "active". A consequence timer (`suspended_until` / `restricted_until`) is only
 * cleared when we are NOT restoring the user *into* that consequence — this
 * prevents an overturn from wiping a separate, still-valid restriction.
 */
async function restoreAccountStatus(
  item: ReviewQueueItem,
  reviewerId: string
): Promise<void> {
  const restoreTo: AccountStatus = item.previousAccountStatus ?? "active";

  try {
    const supabase = getSupabaseServiceClient();

    const updateData: Record<string, unknown> = {
      account_status: restoreTo,
      banned_at: null,
      ban_reason: null,
      status_changed_by: reviewerId,
      status_changed_at: new Date().toISOString(),
    };
    if (restoreTo !== "suspended") updateData.suspended_until = null;
    if (restoreTo !== "restricted") updateData.restricted_until = null;

    await (supabase
      .from("users" as never)
      .update(updateData as never)
      .eq("id", item.targetUserId) as unknown as Promise<{
      error: { message: string } | null;
    }>);

    logger.info("Review: account status restored on overturn", {
      userId: item.targetUserId,
      reviewerId,
      reviewItemId: item.id,
      source: item.source,
      restoredTo: restoreTo,
      route: "platform/moderation/review-service",
    });
  } catch (err) {
    logger.error("Review: account status restoration failed", {
      userId: item.targetUserId,
      reviewerId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/moderation/review-service",
    });
  }
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. F1 — overturn restores to item.previousAccountStatus, NOT unconditionally
//    "active". Escalations skip status restoration entirely (Guardian "escalate"
//    never changes account status). When previousAccountStatus is unknown for a
//    status-changing source, the fallback is "active". A consequence timer is
//    only nulled when we are not restoring INTO that consequence, so an
//    independent suspension/restriction is not wrongly lifted.
//
// 2. previousAccountStatus is populated by producers that own the status change:
//    - middleware escalation → undefined (correct; no status change)
//    - appeals route → derived best-effort from the original Sentinel decision's
//      platform-audit entry (details.previousStatus); undefined if not found
//    - Sentinel ban_review auto-submit is NOT wired yet (ADR-024 §Integration
//      lists it, but no producer calls submitForReview with source "ban_review").
//      Until wired, ban_review items only arrive via the appeals path. Wiring
//      Sentinel → review (passing SentinelResult.previousStatus) is a follow-up.
//
// 3. Strike "expiry" currently only IDENTIFIES the related strike (logs it). It
//    does not yet mutate the strike record. Actual expiry is a follow-up; the
//    StrikeStore exposes expireStrikes() but there is no per-strike expire API.
//
// 4. submitAppeal accepts only a "block" action. A block is the user-facing
//    punishment a user would contest; "escalate" already routes to human
//    review, and "ban" is a downstream Sentinel consequence of a block, not a
//    ModerationAction. The guard and its error message agree (Sprint 6 follow-up).
