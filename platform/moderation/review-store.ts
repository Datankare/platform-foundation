/**
 * platform/moderation/review-store.ts — Review queue persistence
 *
 * ADR-024: Human review queue and appeals.
 * P7: Provider-aware — swap via singleton (InMemory for tests, Supabase for prod).
 * L19: Submit writes are NOT fire-and-forget. Submitting a review item IS
 *      the primary function — the caller must know if it failed.
 * P11: Query failures return empty results — never block the pipeline.
 *
 * Implementations:
 *   InMemoryReviewQueueStore — for tests and development (default)
 *   SupabaseReviewQueueStore — for production (reference implementation)
 *
 * @module platform/moderation
 */

import { logger } from "@/lib/logger";
import type {
  ReviewQueueStore,
  ReviewQueueItem,
  ReviewQueryOptions,
  ReviewQueueStats,
  ReviewItemSource,
  ReviewPriority,
} from "./review-types";

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
  private items: ReviewQueueItem[] = [];
  private idCounter = 0;

  async submit(
    item: Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">
  ): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
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
  ): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) {
      return { success: false, error: `Review item not found: ${id}` };
    }
    const updated: ReviewQueueItem = {
      ...this.items[index],
      ...fields,
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

  /** Test helper */
  getItemCount(): number {
    return this.items.length;
  }

  /** Test helper */
  clear(): void {
    this.items = [];
    this.idCounter = 0;
  }
}

// ---------------------------------------------------------------------------
// SupabaseReviewQueueStore
// ---------------------------------------------------------------------------

/** DB row shape for review_queue */
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
  claimed_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  decision: string | null;
  reviewer_notes: string | null;
  modified_action: string | null;
  previous_account_status: string | null;
  related_strike_id: string | null;
  created_at: string;
  updated_at: string;
}

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
    claimedAt: row.claimed_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    decision: row.decision ? (row.decision as ReviewQueueItem["decision"]) : undefined,
    reviewerNotes: row.reviewer_notes ?? undefined,
    modifiedAction: row.modified_action
      ? (row.modified_action as ReviewQueueItem["modifiedAction"])
      : undefined,
    previousAccountStatus: row.previous_account_status
      ? (row.previous_account_status as ReviewQueueItem["previousAccountStatus"])
      : undefined,
    relatedStrikeId: row.related_strike_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemToRow(
  item: Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">
): Record<string, unknown> {
  return {
    source: item.source,
    priority: item.priority,
    status: item.status,
    moderation_result: item.moderationResult,
    target_user_id: item.targetUserId,
    request_id: item.requestId,
    explanation_chain: item.explanationChain ?? null,
    appeal_reason: item.appealReason ?? null,
    original_decision_id: item.originalDecisionId ?? null,
    claimed_by: item.claimedBy ?? null,
    claimed_at: item.claimedAt ?? null,
    resolved_by: item.resolvedBy ?? null,
    resolved_at: item.resolvedAt ?? null,
    decision: item.decision ?? null,
    reviewer_notes: item.reviewerNotes ?? null,
    modified_action: item.modifiedAction ?? null,
    previous_account_status: item.previousAccountStatus ?? null,
    related_strike_id: item.relatedStrikeId ?? null,
  };
}

export class SupabaseReviewQueueStore implements ReviewQueueStore {
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;

  constructor(supabaseUrl: string, supabaseKey: string) {
    if (typeof window !== "undefined") {
      throw new Error(
        "SupabaseReviewQueueStore must not be instantiated client-side — service role key would leak"
      );
    }
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
  }

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      apikey: this.supabaseKey,
      Authorization: `Bearer ${this.supabaseKey}`,
    };
  }

  async submit(
    item: Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">
  ): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/review_queue`, {
        method: "POST",
        headers: { ...this.headers, Prefer: "return=representation" },
        body: JSON.stringify(itemToRow(item)),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown");
        logger.error("Review store: submit failed", {
          status: response.status,
          error: errText,
          route: "platform/moderation/review-store",
        });
        return { success: false, error: `Submit failed: ${response.status}` };
      }

      const rows = await response.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { success: true, item: mapRowToItem(row as ReviewQueueRow) };
    } catch (err) {
      logger.error("Review store: submit error", {
        error: err instanceof Error ? err.message : String(err),
        route: "platform/moderation/review-store",
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  async getById(id: string): Promise<ReviewQueueItem | undefined> {
    try {
      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/review_queue?id=eq.${id}`,
        { headers: this.headers }
      );
      if (!response.ok) return undefined;
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) return undefined;
      return mapRowToItem(rows[0] as ReviewQueueRow);
    } catch {
      return undefined;
    }
  }

  async getByOriginalDecisionId(
    decisionId: string
  ): Promise<ReviewQueueItem | undefined> {
    try {
      const params = new URLSearchParams();
      params.set("original_decision_id", `eq.${decisionId}`);
      params.set("source", "eq.appeal");
      params.set("status", "neq.resolved");
      params.set("limit", "1");

      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/review_queue?${params.toString()}`,
        { headers: this.headers }
      );
      if (!response.ok) return undefined;
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) return undefined;
      return mapRowToItem(rows[0] as ReviewQueueRow);
    } catch {
      return undefined;
    }
  }

  async update(
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
  ): Promise<{ success: boolean; item?: ReviewQueueItem; error?: string }> {
    try {
      const dbFields: Record<string, unknown> = {
        updated_at: fields.updatedAt ?? new Date().toISOString(),
      };
      if (fields.status !== undefined) dbFields.status = fields.status;
      if (fields.claimedBy !== undefined) dbFields.claimed_by = fields.claimedBy;
      if (fields.claimedAt !== undefined) dbFields.claimed_at = fields.claimedAt;
      if (fields.resolvedBy !== undefined) dbFields.resolved_by = fields.resolvedBy;
      if (fields.resolvedAt !== undefined) dbFields.resolved_at = fields.resolvedAt;
      if (fields.decision !== undefined) dbFields.decision = fields.decision;
      if (fields.reviewerNotes !== undefined)
        dbFields.reviewer_notes = fields.reviewerNotes;
      if (fields.modifiedAction !== undefined)
        dbFields.modified_action = fields.modifiedAction;

      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/review_queue?id=eq.${id}`,
        {
          method: "PATCH",
          headers: { ...this.headers, Prefer: "return=representation" },
          body: JSON.stringify(dbFields),
        }
      );

      if (!response.ok) {
        return { success: false, error: `Update failed: ${response.status}` };
      }

      const rows = await response.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) return { success: false, error: "No row returned" };
      return { success: true, item: mapRowToItem(row as ReviewQueueRow) };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  async query(options?: ReviewQueryOptions): Promise<readonly ReviewQueueItem[]> {
    try {
      const params = new URLSearchParams();
      params.set("order", "created_at.asc");

      if (options?.status) params.set("status", `eq.${options.status}`);
      if (options?.source) params.set("source", `eq.${options.source}`);
      if (options?.priority) params.set("priority", `eq.${options.priority}`);
      if (options?.targetUserId)
        params.set("target_user_id", `eq.${options.targetUserId}`);
      if (options?.claimedBy) params.set("claimed_by", `eq.${options.claimedBy}`);
      if (options?.since) params.set("created_at", `gte.${options.since}`);
      if (options?.before) params.append("created_at", `lt.${options.before}`);
      if (options?.limit && options.limit > 0) params.set("limit", String(options.limit));

      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/review_queue?${params.toString()}`,
        { headers: this.headers }
      );

      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows)
        ? rows.map((r) => mapRowToItem(r as ReviewQueueRow))
        : [];
    } catch {
      return [];
    }
  }

  async getStats(): Promise<ReviewQueueStats> {
    try {
      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/review_queue?order=created_at.desc&limit=10000`,
        { headers: this.headers }
      );
      if (!response.ok) {
        return buildStats([]);
      }
      const rows = await response.json();
      const items = Array.isArray(rows)
        ? rows.map((r) => mapRowToItem(r as ReviewQueueRow))
        : [];
      return buildStats(items);
    } catch {
      return buildStats([]);
    }
  }

  async releaseExpiredClaims(timeoutMs: number): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - timeoutMs).toISOString();
      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/review_queue?status=eq.claimed&claimed_at=lt.${cutoff}`,
        {
          method: "PATCH",
          headers: { ...this.headers, Prefer: "return=representation" },
          body: JSON.stringify({
            status: "pending",
            claimed_by: null,
            claimed_at: null,
            updated_at: new Date().toISOString(),
          }),
        }
      );

      if (!response.ok) return 0;
      const rows = await response.json();
      return Array.isArray(rows) ? rows.length : 0;
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

let currentStore: ReviewQueueStore = new InMemoryReviewQueueStore();

export function getReviewQueueStore(): ReviewQueueStore {
  return currentStore;
}

export function setReviewQueueStore(store: ReviewQueueStore): ReviewQueueStore {
  const previous = currentStore;
  currentStore = store;
  return previous;
}

export function resetReviewQueueStore(): void {
  currentStore = new InMemoryReviewQueueStore();
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
//    no change (it spreads the whole item on submit); only the Supabase row
//    mapping (mapRowToItem / itemToRow) and migration 018 carry it. It is set at
//    submit time and never mutated by update(), so it is intentionally absent
//    from the update() field Pick.
//
// 3. query() uses created_at.asc at the DB layer; priority ordering is applied
//    only by the InMemory store. Supabase consumers that need priority-first
//    ordering should sort client-side or add an order=priority clause.
