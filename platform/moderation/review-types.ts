/**
 * platform/moderation/review-types.ts — Human review queue and appeals types
 *
 * ADR-024: Human review queue for escalations, bans, and appeals.
 * P7: Provider-aware ReviewQueueStore interface.
 * P10: Human oversight as final authority.
 * P6: All review data as structured typed records.
 *
 * @module platform/moderation
 */

import type { AccountStatus, ModerationAction, ModerationResult } from "./types";
import type { ExplanationChain } from "@/platform/rag/types";

// ---------------------------------------------------------------------------
// Review queue item — the core unit of human review
// ---------------------------------------------------------------------------

/**
 * How a review item was created.
 *
 *   escalation — Guardian returned action: "escalate" (low confidence)
 *   ban_review — Sentinel applied a permanent ban
 *   appeal     — User submitted an appeal against a block or ban
 */
export type ReviewItemSource = "escalation" | "ban_review" | "appeal";

/**
 * Review item priority. Determines queue ordering.
 *
 *   critical — ban reviews (must resolve before user can return)
 *   high     — escalations (content is held, user is waiting)
 *   normal   — appeals (user submitted, no urgency)
 */
export type ReviewPriority = "critical" | "high" | "normal";

/**
 * Lifecycle status of a review queue item.
 *
 *   pending  — awaiting a reviewer to claim
 *   claimed  — a reviewer is actively reviewing
 *   resolved — reviewer has made a decision
 */
export type ReviewStatus = "pending" | "claimed" | "resolved";

/**
 * The reviewer's decision on a review item.
 *
 *   uphold   — original automated decision stands
 *   overturn — reverse the decision (restore status, expire strike)
 *   modify   — change severity or action (partial adjustment)
 */
export type ReviewDecision = "uphold" | "overturn" | "modify";

/**
 * A single review queue item. Created by middleware (escalation),
 * Sentinel (ban), or user (appeal).
 */
export interface ReviewQueueItem {
  /** Unique review item ID */
  readonly id: string;
  /** How this item was created */
  readonly source: ReviewItemSource;
  /** Queue priority */
  readonly priority: ReviewPriority;
  /** Current lifecycle status */
  readonly status: ReviewStatus;
  /** The original moderation result being reviewed */
  readonly moderationResult: ModerationResult;
  /** User ID whose content triggered this review */
  readonly targetUserId: string;
  /** Request ID for trace correlation */
  readonly requestId: string;
  /** Explanation chain for reviewer context (from RAG/P10) */
  readonly explanationChain?: ExplanationChain;
  /** Appeal reason (only for source: "appeal") */
  readonly appealReason?: string;
  /** ID of the original decision being appealed (for appeals) */
  readonly originalDecisionId?: string;
  /** Reviewer who claimed this item */
  readonly claimedBy?: string;
  /** When the item was claimed */
  readonly claimedAt?: string;
  /** Reviewer who resolved this item */
  readonly resolvedBy?: string;
  /** When the item was resolved */
  readonly resolvedAt?: string;
  /** The reviewer's decision */
  readonly decision?: ReviewDecision;
  /** Reviewer's notes explaining the decision */
  readonly reviewerNotes?: string;
  /** Modified action (only when decision === "modify") */
  readonly modifiedAction?: ModerationAction;
  /**
   * Account status that existed BEFORE the decision under review was applied.
   *
   * Captured at submission time so that an overturn restores the user to the
   * status they held *before* this decision, rather than blanket-resetting to
   * "active" (F1 — Sprint 6 adversarial review). Left undefined when the source
   * never changed account status (e.g. escalation, where content is held but the
   * account is untouched) or when the prior status could not be determined; in
   * the latter case an overturn falls back to "active".
   */
  readonly previousAccountStatus?: AccountStatus;
  /**
   * The strike a ban_review actioned, recorded for AUDIT / FORENSICS ONLY. This
   * is NEVER the lookup key for strike expiry — overturn resolves the strike via
   * the Guardian decision (StrikeRecord.guardianDecisionId). It exists so a
   * review row records which strike it actioned without a join. Set only for
   * ban_review items.
   */
  readonly relatedStrikeId?: string;
  /** When this item was created */
  readonly createdAt: string;
  /** When this item was last updated */
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Review queue store — persistence interface (P7)
// ---------------------------------------------------------------------------

/** Options for querying the review queue */
export interface ReviewQueryOptions {
  /** Filter by status */
  readonly status?: ReviewStatus;
  /** Filter by source */
  readonly source?: ReviewItemSource;
  /** Filter by priority */
  readonly priority?: ReviewPriority;
  /** Filter by target user */
  readonly targetUserId?: string;
  /** Filter by reviewer */
  readonly claimedBy?: string;
  /** Return items created after this ISO timestamp */
  readonly since?: string;
  /** Return items created before this ISO timestamp */
  readonly before?: string;
  /** Maximum number of results */
  readonly limit?: number;
}

/** Summary statistics for the review queue */
export interface ReviewQueueStats {
  /** Total pending items */
  readonly pendingCount: number;
  /** Total claimed items */
  readonly claimedCount: number;
  /** Total resolved items */
  readonly resolvedCount: number;
  /** Pending items by source */
  readonly pendingBySource: Readonly<Record<ReviewItemSource, number>>;
  /** Pending items by priority */
  readonly pendingByPriority: Readonly<Record<ReviewPriority, number>>;
  /** Average resolution time in ms (last 100 resolved items) */
  readonly avgResolutionMs: number;
}

/**
 * ReviewQueueStore — persistence interface for review queue items.
 *
 * Implementations:
 *   InMemoryReviewQueueStore — for tests and development (default)
 *   SupabaseReviewQueueStore — for production (reference)
 *
 * Any backend can implement this interface. The singleton pattern
 * (get/set/resetReviewQueueStore) allows swapping at runtime.
 *
 * Store failures on submit are surfaced (L19 — review submission IS
 * the primary function). Store failures on query return empty results
 * (P11 — query failures don't block the pipeline).
 */
export interface ReviewQueueStore {
  /** Submit a new review item. Returns the created item or error (L19). */
  submit(
    item: Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">
  ): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }>;

  /** Get a review item by ID. */
  getById(id: string): Promise<ReviewQueueItem | undefined>;

  /** Get a review item by original decision ID (for appeal dedup). */
  getByOriginalDecisionId(decisionId: string): Promise<ReviewQueueItem | undefined>;

  /** Update a review item (claim, resolve, unclaim). */
  update(
    id: string,
    fields: Partial<
      Pick<
        ReviewQueueItem,
        | "status"
        | "claimedBy"
        | "claimedAt"
        | "resolvedBy"
        | "resolvedAt"
        | "decision"
        | "reviewerNotes"
        | "modifiedAction"
        | "updatedAt"
      >
    >
  ): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }>;

  /** Query review items with filters. */
  query(options?: ReviewQueryOptions): Promise<readonly ReviewQueueItem[]>;

  /** Get queue statistics. */
  getStats(): Promise<ReviewQueueStats>;

  /** Release claimed items that have exceeded the timeout. Returns count released. */
  releaseExpiredClaims(timeoutMs: number): Promise<number>;
}
