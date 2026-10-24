/**
 * platform/moderation/review-store.ts — Review queue persistence
 *
 * ADR-024: Human review queue and appeals.
 * ADR-053 D4: Postgres through platform/data, in the request's tenant.
 * P7: Provider-aware — swap via singleton (InMemory for tests, Postgres for prod).
 * L19: Submit writes are NOT fire-and-forget. Submitting a review item IS
 *      the primary function — the caller must know if it failed.
 * P11: Query failures return empty results — never block the pipeline.
 *
 * Implementations:
 *   InMemoryReviewQueueStore — for tests and development (default); one partition per tenant
 *   PostgresReviewQueueStore — for production
 *
 * @module platform/moderation
 */

import { logger } from "@/lib/logger";
import type {
  ReviewQueueStore,
  ReviewQueueUpdate,
  ReviewUpdateExpectation,
  ReviewQueueItem,
  ReviewQueryOptions,
  ReviewQueueStats,
  ReviewItemSource,
  ReviewPriority,
  ReviewResult,
} from "./review-types";
import { withTenantTx } from "@/platform/data";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";

// ---------------------------------------------------------------------------
// Priority ordering (for queue sort)
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<ReviewPriority, number> = {
  critical: 2,
  high: 1,
  normal: 0,
};

// ---------------------------------------------------------------------------
// Stats builder (shared by both implementations)
// ---------------------------------------------------------------------------

function buildStats(items: readonly ReviewQueueItem[]): ReviewQueueStats {
  const pendingBySource: Record<ReviewItemSource, number> = {
    escalation: 0,
    ban_review: 0,
    appeal: 0,
  };
  const pendingByPriority: Record<ReviewPriority, number> = {
    critical: 0,
    high: 0,
    normal: 0,
  };

  let pendingCount = 0;
  let claimedCount = 0;
  let resolvedCount = 0;
  const resolutionTimes: number[] = [];

  for (const item of items) {
    if (item.status === "pending") {
      pendingCount++;
      pendingBySource[item.source]++;
      pendingByPriority[item.priority]++;
    } else if (item.status === "claimed") {
      claimedCount++;
    } else if (item.status === "resolved") {
      resolvedCount++;
      if (item.resolvedAt && item.createdAt) {
        const ms =
          new Date(item.resolvedAt).getTime() - new Date(item.createdAt).getTime();
        if (ms >= 0) resolutionTimes.push(ms);
      }
    }
  }

  const recentTimes = resolutionTimes.slice(-100);
  const avgResolutionMs =
    recentTimes.length > 0
      ? recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length
      : 0;

  return {
    pendingCount,
    claimedCount,
    resolvedCount,
    pendingBySource,
    pendingByPriority,
    avgResolutionMs,
  };
}

// ---------------------------------------------------------------------------
// InMemoryReviewQueueStore
// ---------------------------------------------------------------------------

export class InMemoryReviewQueueStore implements ReviewQueueStore {
  private static readonly MAX_ITEMS = 10_000;
  /** One list per tenant (ADR-053 D6), so a tenant sees only its own queue. */
  private readonly parts = new TenantPartitionedMap<"items", ReviewQueueItem[]>();
  private idCounter = 0;

  private get items(): ReviewQueueItem[] {
    const part = this.parts.current();
    let list = part.get("items");
    if (!list) {
      list = [];
      part.set("items", list);
    }
    return list;
  }

  private set items(next: ReviewQueueItem[]) {
    this.parts.current().set("items", next);
  }

  async submit(
    item: Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">
  ): Promise<ReviewResult> {
    const now = new Date().toISOString();
    const record: ReviewQueueItem = {
      ...item,
      id: `review-${++this.idCounter}`,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(record);
    if (this.items.length > InMemoryReviewQueueStore.MAX_ITEMS) {
      this.items = this.items.slice(-InMemoryReviewQueueStore.MAX_ITEMS);
    }
    return { success: true, item: record };
  }

  async getById(id: string): Promise<ReviewQueueItem | undefined> {
    return this.items.find((i) => i.id === id);
  }

  async getByOriginalDecisionId(
    decisionId: string
  ): Promise<ReviewQueueItem | undefined> {
    return this.items.find(
      (i) =>
        i.originalDecisionId === decisionId &&
        i.source === "appeal" &&
        i.status !== "resolved"
    );
  }

  async update(
    id: string,
    fields: ReviewQueueUpdate,
    expected?: ReviewUpdateExpectation
  ): Promise<ReviewResult> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) {
      return {
        success: false,
        error: `Review item not found: ${id}`,
        errorCode: "moderation.review_item_not_found",
      };
    }
    const current = this.items[index];
    if (
      (expected?.status !== undefined && current.status !== expected.status) ||
      (expected?.claimedBy !== undefined && current.claimedBy !== expected.claimedBy)
    ) {
      return {
        success: false,
        error: `Item is ${current.status}${current.claimedBy ? ` (claimed by another reviewer)` : ""}`,
        errorCode: "moderation.item_state_conflict",
        errorParams: { status: current.status },
      };
    }
    const { claimedBy, claimedAt, ...rest } = fields;
    const updated: ReviewQueueItem = {
      ...current,
      ...rest,
      ...(claimedBy === null
        ? { claimedBy: undefined }
        : claimedBy !== undefined
          ? { claimedBy }
          : {}),
      ...(claimedAt === null
        ? { claimedAt: undefined }
        : claimedAt !== undefined
          ? { claimedAt }
          : {}),
      updatedAt: fields.updatedAt ?? new Date().toISOString(),
    };
    this.items[index] = updated;
    return { success: true, item: updated };
  }

  async query(options?: ReviewQueryOptions): Promise<readonly ReviewQueueItem[]> {
    let filtered = [...this.items];

    if (options?.status) {
      filtered = filtered.filter((i) => i.status === options.status);
    }
    if (options?.source) {
      filtered = filtered.filter((i) => i.source === options.source);
    }
    if (options?.priority) {
      filtered = filtered.filter((i) => i.priority === options.priority);
    }
    if (options?.targetUserId) {
      filtered = filtered.filter((i) => i.targetUserId === options.targetUserId);
    }
    if (options?.claimedBy) {
      filtered = filtered.filter((i) => i.claimedBy === options.claimedBy);
    }
    if (options?.since) {
      filtered = filtered.filter((i) => i.createdAt >= options.since!);
    }
    if (options?.before) {
      filtered = filtered.filter((i) => i.createdAt < options.before!);
    }

    // Sort: priority desc, then createdAt asc (oldest first within priority)
    filtered.sort((a, b) => {
      const pDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (pDiff !== 0) return pDiff;
      return a.createdAt.localeCompare(b.createdAt);
    });

    if (options?.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  async getStats(): Promise<ReviewQueueStats> {
    return buildStats(this.items);
  }

  async releaseExpiredClaims(timeoutMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    let count = 0;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.status === "claimed" && item.claimedAt && item.claimedAt < cutoff) {
        this.items[i] = {
          ...item,
          status: "pending",
          claimedBy: undefined,
          claimedAt: undefined,
          updatedAt: new Date().toISOString(),
        };
        count++;
      }
    }
    return count;
  }

  /** Test helper: the current tenant's item count. */
  getItemCount(): number {
    return this.items.length;
  }

  /** Test helper: forget every tenant's items. */
  clear(): void {
    this.parts.clearAll();
    this.idCounter = 0;
  }
}

// ---------------------------------------------------------------------------
// PostgresReviewQueueStore
// ---------------------------------------------------------------------------

/** One review_queue row as pg returns it (timestamptz → Date, jsonb parsed). */
interface ReviewQueueRow {
  id: string;
  source: string;
  priority: string;
  status: string;
  moderation_result: Record<string, unknown>;
  target_user_id: string;
  request_id: string;
  explanation_chain: Record<string, unknown> | null;
  appeal_reason: string | null;
  original_decision_id: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  decision: string | null;
  reviewer_notes: string | null;
  modified_action: string | null;
  previous_account_status: string | null;
  related_strike_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

function mapRowToItem(row: ReviewQueueRow): ReviewQueueItem {
  return {
    id: row.id,
    source: row.source as ReviewQueueItem["source"],
    priority: row.priority as ReviewQueueItem["priority"],
    status: row.status as ReviewQueueItem["status"],
    moderationResult:
      row.moderation_result as unknown as ReviewQueueItem["moderationResult"],
    targetUserId: row.target_user_id,
    requestId: row.request_id,
    explanationChain: row.explanation_chain
      ? (row.explanation_chain as unknown as ReviewQueueItem["explanationChain"])
      : undefined,
    appealReason: row.appeal_reason ?? undefined,
    originalDecisionId: row.original_decision_id ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at ? iso(row.claimed_at) : undefined,
    resolvedBy: row.resolved_by ?? undefined,
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : undefined,
    decision: row.decision ? (row.decision as ReviewQueueItem["decision"]) : undefined,
    reviewerNotes: row.reviewer_notes ?? undefined,
    modifiedAction: row.modified_action
      ? (row.modified_action as ReviewQueueItem["modifiedAction"])
      : undefined,
    previousAccountStatus: row.previous_account_status
      ? (row.previous_account_status as ReviewQueueItem["previousAccountStatus"])
      : undefined,
    relatedStrikeId: row.related_strike_id ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * The review queue in review_queue, in the request's tenant: row-level security keeps each
 * tenant's queue apart, and the (tenant_id, target_user_id) foreign key means an item can only
 * name a user of the same tenant. Submit failures are returned (L19); query failures return
 * nothing (P11).
 */
export class PostgresReviewQueueStore implements ReviewQueueStore {
  async submit(
    item: Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">
  ): Promise<ReviewResult> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<ReviewQueueRow>(
          `insert into review_queue (source, priority, status, moderation_result,
             target_user_id, request_id, explanation_chain, appeal_reason, original_decision_id,
             claimed_by, claimed_at, resolved_by, resolved_at, decision, reviewer_notes,
             modified_action, previous_account_status, related_strike_id)
           values ($1, $2, $3, $4::jsonb, $5::uuid, $6, $7::jsonb, $8, $9, $10,
             $11::timestamptz, $12, $13::timestamptz, $14, $15, $16, $17, $18)
           returning id, source, priority, status, moderation_result, target_user_id,
             request_id, explanation_chain, appeal_reason, original_decision_id, claimed_by,
             claimed_at, resolved_by, resolved_at, decision, reviewer_notes, modified_action,
             previous_account_status, related_strike_id, created_at, updated_at`,
          [
            item.source,
            item.priority,
            item.status,
            JSON.stringify(item.moderationResult),
            item.targetUserId,
            item.requestId,
            item.explanationChain ? JSON.stringify(item.explanationChain) : null,
            item.appealReason ?? null,
            item.originalDecisionId ?? null,
            item.claimedBy ?? null,
            item.claimedAt ?? null,
            item.resolvedBy ?? null,
            item.resolvedAt ?? null,
            item.decision ?? null,
            item.reviewerNotes ?? null,
            item.modifiedAction ?? null,
            item.previousAccountStatus ?? null,
            item.relatedStrikeId ?? null,
          ]
        )
      );
      return { success: true, item: mapRowToItem(rows[0]) };
    } catch (err) {
      logger.error("Review store: submit failed", {
        error: err instanceof Error ? err.message : String(err),
        route: "platform/moderation/review-store",
      });
      return {
        success: false,
        error: err instanceof Error ? `Submit failed: ${err.message}` : "Unknown error",
        errorCode: "internal.error",
      };
    }
  }

  async getById(id: string): Promise<ReviewQueueItem | undefined> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<ReviewQueueRow>(
          `select id, source, priority, status, moderation_result, target_user_id, request_id,
                  explanation_chain, appeal_reason, original_decision_id, claimed_by,
                  claimed_at, resolved_by, resolved_at, decision, reviewer_notes,
                  modified_action, previous_account_status, related_strike_id, created_at,
                  updated_at
             from review_queue where id = $1::uuid`,
          [id]
        )
      );
      return rows[0] ? mapRowToItem(rows[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  async getByOriginalDecisionId(
    decisionId: string
  ): Promise<ReviewQueueItem | undefined> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<ReviewQueueRow>(
          `select id, source, priority, status, moderation_result, target_user_id, request_id,
                  explanation_chain, appeal_reason, original_decision_id, claimed_by,
                  claimed_at, resolved_by, resolved_at, decision, reviewer_notes,
                  modified_action, previous_account_status, related_strike_id, created_at,
                  updated_at
             from review_queue
            where original_decision_id = $1 and source = 'appeal' and status <> 'resolved'
            limit 1`,
          [decisionId]
        )
      );
      return rows[0] ? mapRowToItem(rows[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Set the given fields; a field left undefined keeps its value (it is never cleared — the
   * same as the REST store this replaces, which dropped undefined fields from the patch).
   */
  async update(
    id: string,
    fields: ReviewQueueUpdate,
    expected?: ReviewUpdateExpectation
  ): Promise<ReviewResult> {
    try {
      return await withTenantTx(async (tx): Promise<ReviewResult> => {
        const { rows } = await tx.query<ReviewQueueRow>(
          `update review_queue set
              updated_at = coalesce($2::timestamptz, now()),
              status = coalesce($3, status),
              claimed_by = case when $12::boolean then null else coalesce($4, claimed_by) end,
              claimed_at = case when $13::boolean then null else coalesce($5::timestamptz, claimed_at) end,
              resolved_by = coalesce($6, resolved_by),
              resolved_at = coalesce($7::timestamptz, resolved_at),
              decision = coalesce($8, decision),
              reviewer_notes = coalesce($9, reviewer_notes),
              modified_action = coalesce($10, modified_action),
              priority = coalesce($11, priority)
            where id = $1::uuid
              and ($14::text is null or status = $14)
              and ($15::text is null or claimed_by is not distinct from $15)
            returning id, source, priority, status, moderation_result, target_user_id,
              request_id, explanation_chain, appeal_reason, original_decision_id, claimed_by,
              claimed_at, resolved_by, resolved_at, decision, reviewer_notes, modified_action,
              previous_account_status, related_strike_id, created_at, updated_at`,
          [
            id,
            fields.updatedAt ?? null,
            fields.status ?? null,
            fields.claimedBy ?? null,
            fields.claimedAt ?? null,
            fields.resolvedBy ?? null,
            fields.resolvedAt ?? null,
            fields.decision ?? null,
            fields.reviewerNotes ?? null,
            fields.modifiedAction ?? null,
            fields.priority ?? null,
            fields.claimedBy === null,
            fields.claimedAt === null,
            expected?.status ?? null,
            expected?.claimedBy ?? null,
          ]
        );
        if (rows[0]) return { success: true, item: mapRowToItem(rows[0]) };
        // Nothing updated: the item does not exist, or is no longer in the expected state.
        const now = await tx.query<{ status: string }>(
          "select status from review_queue where id = $1::uuid",
          [id]
        );
        return now.rows[0]
          ? {
              success: false,
              error: `Item is ${now.rows[0].status}, not in the expected state`,
              errorCode: "moderation.item_state_conflict",
              errorParams: { status: now.rows[0].status },
            }
          : {
              success: false,
              error: `Review item not found: ${id}`,
              errorCode: "moderation.review_item_not_found",
            };
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? `Update failed: ${err.message}` : "Unknown error",
        errorCode: "internal.error",
      };
    }
  }

  async query(options?: ReviewQueryOptions): Promise<readonly ReviewQueueItem[]> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<ReviewQueueRow>(
          `select id, source, priority, status, moderation_result, target_user_id, request_id,
                  explanation_chain, appeal_reason, original_decision_id, claimed_by,
                  claimed_at, resolved_by, resolved_at, decision, reviewer_notes,
                  modified_action, previous_account_status, related_strike_id, created_at,
                  updated_at
             from review_queue
            where ($1::text is null or status = $1::text)
              and ($2::text is null or source = $2::text)
              and ($3::text is null or priority = $3::text)
              and ($4::uuid is null or target_user_id = $4::uuid)
              and ($5::text is null or claimed_by = $5::text)
              and ($6::timestamptz is null or created_at >= $6::timestamptz)
              and ($7::timestamptz is null or created_at < $7::timestamptz)
            order by created_at asc
            limit $8::integer`,
          [
            options?.status || null,
            options?.source || null,
            options?.priority || null,
            options?.targetUserId || null,
            options?.claimedBy || null,
            options?.since || null,
            options?.before || null,
            options?.limit && options.limit > 0 ? options.limit : null,
          ]
        )
      );
      return rows.map(mapRowToItem);
    } catch {
      return [];
    }
  }

  async getStats(): Promise<ReviewQueueStats> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<ReviewQueueRow>(
          `select id, source, priority, status, moderation_result, target_user_id, request_id,
                  explanation_chain, appeal_reason, original_decision_id, claimed_by,
                  claimed_at, resolved_by, resolved_at, decision, reviewer_notes,
                  modified_action, previous_account_status, related_strike_id, created_at,
                  updated_at
             from review_queue
            order by created_at desc
            limit 10000`
        )
      );
      return buildStats(rows.map(mapRowToItem));
    } catch {
      return buildStats([]);
    }
  }

  async releaseExpiredClaims(timeoutMs: number): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - timeoutMs).toISOString();
      const { rowCount } = await withTenantTx((tx) =>
        tx.query(
          `update review_queue
              set status = 'pending', claimed_by = null, claimed_at = null, updated_at = now()
            where status = 'claimed' and claimed_at < $1::timestamptz`,
          [cutoff]
        )
      );
      return rowCount;
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const REVIEWQUEUESTORE_KEY = "platform.moderation.reviewQueueStore";
function readCurrentStore(): ReviewQueueStore {
  return getSingleton<ReviewQueueStore>(
    REVIEWQUEUESTORE_KEY,
    () => new InMemoryReviewQueueStore()
  );
}
function writeCurrentStore(next: ReviewQueueStore): void {
  setSingleton<ReviewQueueStore>(REVIEWQUEUESTORE_KEY, next);
}

export function getReviewQueueStore(): ReviewQueueStore {
  return readCurrentStore();
}

export function setReviewQueueStore(store: ReviewQueueStore): ReviewQueueStore {
  const previous = readCurrentStore();
  writeCurrentStore(store);
  return previous;
}

export function resetReviewQueueStore(): void {
  writeCurrentStore(new InMemoryReviewQueueStore());
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. JSON columns (moderation_result, explanation_chain) map through
//    `as unknown as TargetType` — a direct cast from Record<string, unknown>
//    fails TypeScript's overlap check (Gotcha-57).
//
// 2. previous_account_status (F1) is an additive column — InMemory store needs
//    no change (it spreads the whole item on submit); only the Postgres row
//    mapping (submit's insert / mapRowToItem) and migration 018 carry it. It is set at
//    submit time and never mutated by update(), so it is intentionally absent
//    from the update() field Pick.
//
// 3. query() uses created_at.asc at the DB layer; priority ordering is applied
//    only by the InMemory store. Postgres consumers that need priority-first
//    ordering should sort client-side or add a priority ordering.
