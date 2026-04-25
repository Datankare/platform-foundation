/**
 * platform/moderation/strikes.ts — Strike persistence service
 *
 * Records and queries user strikes for the account consequences system.
 * The Sentinel agent calls recordStrike() after a Guardian block decision.
 *
 * P7: Provider-aware — swap via singleton (InMemory for tests, Supabase for prod).
 * L19: Strike writes are NOT fire-and-forget. Recording a strike IS the
 *      primary function — the caller must know if it failed.
 *
 * Implementations:
 *   InMemoryStrikeStore — for tests and development (default)
 *   SupabaseStrikeStore — for production
 *
 * @module platform/moderation
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import type {
  StrikeStore,
  StrikeRecord,
  StrikeQueryOptions,
  StrikeSummary,
} from "./types";
import type { SafetySeverity } from "@/prompts/safety/classify-v1";

// ---------------------------------------------------------------------------
// Severity ordering (for highestSeverity in summary)
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function highestSeverity(a: SafetySeverity | null, b: SafetySeverity): SafetySeverity {
  if (!a) return b;
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

// ---------------------------------------------------------------------------
// Summary builder (shared by both implementations)
// ---------------------------------------------------------------------------

function buildSummary(strikes: readonly StrikeRecord[]): StrikeSummary {
  const byCategory: Record<string, number> = {};
  let highest: SafetySeverity | null = null;

  for (const s of strikes) {
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
    highest = highestSeverity(highest, s.severity);
  }

  return {
    totalActive: strikes.length,
    byCategory,
    mostRecent: strikes.length > 0 ? strikes[0] : null,
    highestSeverity: highest,
  };
}

// ---------------------------------------------------------------------------
// InMemoryStrikeStore
// ---------------------------------------------------------------------------

export class InMemoryStrikeStore implements StrikeStore {
  private records: StrikeRecord[] = [];
  private idCounter = 0;

  async recordStrike(
    strike: Omit<StrikeRecord, "id" | "createdAt">
  ): Promise<{ success: boolean; record?: StrikeRecord; error?: string }> {
    const record: StrikeRecord = {
      ...strike,
      id: `strike-${++this.idCounter}`,
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    return { success: true, record };
  }

  async getActiveStrikes(userId: string): Promise<readonly StrikeRecord[]> {
    const now = new Date();
    return this.records
      .filter(
        (r) =>
          r.userId === userId &&
          !r.expired &&
          (r.expiresAt === null || new Date(r.expiresAt) > now)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async getStrikeSummary(userId: string): Promise<StrikeSummary> {
    const active = await this.getActiveStrikes(userId);
    return buildSummary(active);
  }

  async queryStrikes(options: StrikeQueryOptions): Promise<readonly StrikeRecord[]> {
    let filtered = this.records.filter((r) => r.userId === options.userId);

    if (options.activeOnly) {
      const now = new Date();
      filtered = filtered.filter(
        (r) => !r.expired && (r.expiresAt === null || new Date(r.expiresAt) > now)
      );
    }

    if (options.category) {
      filtered = filtered.filter((r) => r.category === options.category);
    }

    filtered.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    );

    if (options.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  async expireStrikes(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const r of this.records) {
      if (!r.expired && r.expiresAt !== null && new Date(r.expiresAt) <= now) {
        // StrikeRecord is readonly — create replacement
        const idx = this.records.indexOf(r);
        this.records[idx] = { ...r, expired: true };
        count++;
      }
    }
    return count;
  }

  /** Test helper */
  getRecordCount(): number {
    return this.records.length;
  }

  /** Test helper */
  clear(): void {
    this.records = [];
    this.idCounter = 0;
  }
}

// ---------------------------------------------------------------------------
// SupabaseStrikeStore
// ---------------------------------------------------------------------------

/** DB row shape for user_strikes */
interface StrikeRow {
  id: string;
  user_id: string;
  category: string;
  severity: string;
  moderation_audit_id: string | null;
  trajectory_id: string;
  agent_id: string;
  reason: string;
  expires_at: string | null;
  expired: boolean;
  created_at: string;
}

function mapRowToStrike(row: StrikeRow): StrikeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category,
    severity: row.severity as SafetySeverity,
    moderationAuditId: row.moderation_audit_id,
    trajectoryId: row.trajectory_id,
    agentId: row.agent_id,
    reason: row.reason,
    expiresAt: row.expires_at,
    expired: row.expired,
    createdAt: row.created_at,
  };
}

export class SupabaseStrikeStore implements StrikeStore {
  async recordStrike(
    strike: Omit<StrikeRecord, "id" | "createdAt">
  ): Promise<{ success: boolean; record?: StrikeRecord; error?: string }> {
    try {
      const supabase = getSupabaseServiceClient();
      const { data, error } = await (supabase
        .from("user_strikes" as never)
        .insert({
          user_id: strike.userId,
          category: strike.category,
          severity: strike.severity,
          moderation_audit_id: strike.moderationAuditId,
          trajectory_id: strike.trajectoryId,
          agent_id: strike.agentId,
          reason: strike.reason,
          expires_at: strike.expiresAt,
          expired: false,
        } as never)
        .select(
          "id, user_id, category, severity, moderation_audit_id, trajectory_id, agent_id, reason, expires_at, expired, created_at"
        )
        .single() as unknown as Promise<{
        data: StrikeRow | null;
        error: { message: string } | null;
      }>);

      if (error || !data) {
        logger.error("Strike recording failed", {
          userId: strike.userId,
          category: strike.category,
          error: error?.message ?? "No data returned",
          route: "platform/moderation/strikes",
        });
        return { success: false, error: error?.message ?? "Failed to record strike" };
      }

      return { success: true, record: mapRowToStrike(data) };
    } catch (err) {
      logger.error("Strike recording error", {
        userId: strike.userId,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/moderation/strikes",
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  async getActiveStrikes(userId: string): Promise<readonly StrikeRecord[]> {
    try {
      const supabase = getSupabaseServiceClient();
      const { data, error } = await (supabase
        .from("user_strikes" as never)
        .select(
          "id, user_id, category, severity, moderation_audit_id, trajectory_id, agent_id, reason, expires_at, expired, created_at"
        )
        .eq("user_id", userId)
        .eq("expired", false)
        .order("created_at", { ascending: false }) as unknown as Promise<{
        data: StrikeRow[] | null;
        error: { message: string } | null;
      }>);

      if (error || !data) return [];

      // Filter out time-expired but not yet marked
      const now = new Date();
      return data
        .filter((r) => r.expires_at === null || new Date(r.expires_at) > now)
        .map(mapRowToStrike);
    } catch {
      return [];
    }
  }

  async getStrikeSummary(userId: string): Promise<StrikeSummary> {
    const active = await this.getActiveStrikes(userId);
    return buildSummary(active);
  }

  async queryStrikes(options: StrikeQueryOptions): Promise<readonly StrikeRecord[]> {
    try {
      const supabase = getSupabaseServiceClient();
      let query = supabase
        .from("user_strikes" as never)
        .select(
          "id, user_id, category, severity, moderation_audit_id, trajectory_id, agent_id, reason, expires_at, expired, created_at"
        )
        .eq("user_id", options.userId)
        .order("created_at", { ascending: false });

      if (options.activeOnly) {
        query = query.eq("expired", false);
      }
      if (options.category) {
        query = query.eq("category", options.category);
      }

      const limit = options.limit ?? 50;
      query = query.limit(limit);

      const { data, error } = (await query) as {
        data: StrikeRow[] | null;
        error: { message: string } | null;
      };

      if (error || !data) return [];
      return data.map(mapRowToStrike);
    } catch {
      return [];
    }
  }

  async expireStrikes(): Promise<number> {
    try {
      const supabase = getSupabaseServiceClient();
      const now = new Date().toISOString();

      const { data, error } = await (supabase
        .from("user_strikes" as never)
        .update({ expired: true } as never)
        .eq("expired", false)
        .lt("expires_at", now)
        .select("id") as unknown as Promise<{
        data: Array<{ id: string }> | null;
        error: { message: string } | null;
      }>);

      if (error) {
        logger.error("Strike expiry failed", {
          error: error.message,
          route: "platform/moderation/strikes",
        });
        return 0;
      }

      return data?.length ?? 0;
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

let currentStore: StrikeStore = new InMemoryStrikeStore();

export function getStrikeStore(): StrikeStore {
  return currentStore;
}

export function setStrikeStore(store: StrikeStore): StrikeStore {
  const previous = currentStore;
  currentStore = store;
  return previous;
}

export function resetStrikeStore(): void {
  currentStore = new InMemoryStrikeStore();
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. StrikeRecord fields are readonly. InMemoryStrikeStore works around this
//    by creating new objects via spread when marking expired.
//
// 2. SupabaseStrikeStore.getActiveStrikes filters time-expired strikes in
//    memory (not just by the `expired` flag) because the cron job that sets
//    expired=true may not have run yet. This is intentional double-checking.
//
// 3. Unlike ModerationStore, recordStrike returns {success, error} per L19.
//    The Sentinel must check this result and surface failures.
//
// 4. buildSummary assumes strikes are sorted newest-first. Both store
//    implementations sort by created_at DESC before building summary.
//
// 5. The SEVERITY_RANK map must match the one in guardian.ts. If severity
//    levels are ever changed, update both files.
