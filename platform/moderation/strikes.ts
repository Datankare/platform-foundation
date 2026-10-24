/**
 * platform/moderation/strikes.ts — Strike persistence service
 *
 * Records and queries user strikes for the account consequences system.
 * The Sentinel agent calls recordStrike() after a Guardian block decision.
 *
 * P7: Provider-aware — swap via singleton (InMemory for tests, Postgres for prod).
 * ADR-053 D4: Postgres through platform/data, in the request's tenant.
 * L19: Strike writes are NOT fire-and-forget. Recording a strike IS the
 *      primary function — the caller must know if it failed.
 *
 * Implementations:
 *   InMemoryStrikeStore — for tests and development (default); one partition per tenant
 *   PostgresStrikeStore — for production
 *
 * @module platform/moderation
 */

import { logger } from "@/lib/logger";
import { withTenantTx } from "@/platform/data";
import type {
  StrikeStore,
  StrikeRecord,
  StrikeQueryOptions,
  StrikeSummary,
} from "./types";
import type { SafetySeverity } from "@/prompts/safety/classify-v1";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";

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
  /** One list per tenant (ADR-053 D6), so a tenant sees only its own strikes. */
  private readonly parts = new TenantPartitionedMap<"records", StrikeRecord[]>();
  private idCounter = 0;

  private get records(): StrikeRecord[] {
    const part = this.parts.current();
    let list = part.get("records");
    if (!list) {
      list = [];
      part.set("records", list);
    }
    return list;
  }

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

  async expireStrike(strikeId: string): Promise<boolean> {
    const idx = this.records.findIndex((r) => r.id === strikeId);
    if (idx === -1 || this.records[idx].expired) return false;
    // StrikeRecord is readonly — create replacement
    this.records[idx] = { ...this.records[idx], expired: true };
    return true;
  }

  /** Test helper: the current tenant's strike count. */
  getRecordCount(): number {
    return this.records.length;
  }

  /** Test helper: forget every tenant's strikes. */
  clear(): void {
    this.parts.clearAll();
    this.idCounter = 0;
  }
}

// ---------------------------------------------------------------------------
// PostgresStrikeStore
// ---------------------------------------------------------------------------

/** One user_strikes row as pg returns it (timestamptz → Date). */
interface StrikeRow {
  id: string;
  user_id: string;
  category: string;
  severity: string;
  moderation_audit_id: string | null;
  guardian_decision_id: string | null;
  trajectory_id: string;
  agent_id: string;
  reason: string;
  expires_at: Date | null;
  expired: boolean;
  created_at: Date;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

function mapRowToStrike(row: StrikeRow): StrikeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category,
    severity: row.severity as SafetySeverity,
    moderationAuditId: row.moderation_audit_id,
    guardianDecisionId: row.guardian_decision_id,
    trajectoryId: row.trajectory_id,
    agentId: row.agent_id,
    reason: row.reason,
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    expired: row.expired,
    createdAt: iso(row.created_at),
  };
}

/**
 * Strikes in user_strikes, in the request's tenant: row-level security keeps each tenant's
 * strikes apart, and the (tenant_id, user_id) foreign key means a strike can only name a user
 * of the same tenant.
 */
export class PostgresStrikeStore implements StrikeStore {
  async recordStrike(
    strike: Omit<StrikeRecord, "id" | "createdAt">
  ): Promise<{ success: boolean; record?: StrikeRecord; error?: string }> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<StrikeRow>(
          `insert into user_strikes (user_id, category, severity, moderation_audit_id,
             guardian_decision_id, trajectory_id, agent_id, reason, expires_at, expired)
           values ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9::timestamptz, false)
           returning id, user_id, category, severity, moderation_audit_id, guardian_decision_id,
             trajectory_id, agent_id, reason, expires_at, expired, created_at`,
          [
            strike.userId,
            strike.category,
            strike.severity,
            strike.moderationAuditId,
            strike.guardianDecisionId,
            strike.trajectoryId,
            strike.agentId,
            strike.reason,
            strike.expiresAt,
          ]
        )
      );
      return { success: true, record: mapRowToStrike(rows[0]) };
    } catch (err) {
      logger.error("Strike recording failed", {
        userId: strike.userId,
        category: strike.category,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/moderation/strikes",
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : "Failed to record strike",
      };
    }
  }

  async getActiveStrikes(userId: string): Promise<readonly StrikeRecord[]> {
    try {
      // A strike past its expiry no longer counts even before the sweep marks it expired.
      const { rows } = await withTenantTx((tx) =>
        tx.query<StrikeRow>(
          `select id, user_id, category, severity, moderation_audit_id, guardian_decision_id,
                  trajectory_id, agent_id, reason, expires_at, expired, created_at
             from user_strikes
            where user_id = $1::uuid and expired = false
              and (expires_at is null or expires_at > now())
            order by created_at desc, id desc`,
          [userId]
        )
      );
      return rows.map(mapRowToStrike);
    } catch (err) {
      // Fail closed: an unreadable strike history is not "no strikes" — that would let every
      // block during an outage pass without consequence (Sprint 7X). Callers surface the error.
      logger.error("Strike history could not be read", {
        userId,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/moderation/strikes",
      });
      throw new Error(
        `strike history unreadable: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  async getStrikeSummary(userId: string): Promise<StrikeSummary> {
    const active = await this.getActiveStrikes(userId);
    return buildSummary(active);
  }

  async queryStrikes(options: StrikeQueryOptions): Promise<readonly StrikeRecord[]> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<StrikeRow>(
          `select id, user_id, category, severity, moderation_audit_id, guardian_decision_id,
                  trajectory_id, agent_id, reason, expires_at, expired, created_at
             from user_strikes
            where user_id = $1::uuid
              and ($2::boolean is not true or expired = false)
              and ($3::text is null or category = $3::text)
            order by created_at desc, id desc
            limit $4::integer`,
          [
            options.userId,
            options.activeOnly ?? false,
            options.category || null,
            options.limit ?? 50,
          ]
        )
      );
      return rows.map(mapRowToStrike);
    } catch {
      return [];
    }
  }

  async expireStrikes(): Promise<number> {
    try {
      const { rowCount } = await withTenantTx((tx) =>
        tx.query(
          "update user_strikes set expired = true where expired = false and expires_at < now()"
        )
      );
      return rowCount;
    } catch (err) {
      logger.error("Strike expiry failed", {
        error: err instanceof Error ? err.message : String(err),
        route: "platform/moderation/strikes",
      });
      return 0;
    }
  }

  async expireStrike(strikeId: string): Promise<boolean> {
    try {
      const { rowCount } = await withTenantTx((tx) =>
        tx.query(
          "update user_strikes set expired = true where id = $1::uuid and expired = false",
          [strikeId]
        )
      );
      return rowCount > 0;
    } catch (err) {
      logger.error("Single strike expiry failed", {
        strikeId,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/moderation/strikes",
      });
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const STRIKESTORE_KEY = "platform.moderation.strikeStore";
function readCurrentStore(): StrikeStore {
  return getSingleton<StrikeStore>(STRIKESTORE_KEY, () => new InMemoryStrikeStore());
}
function writeCurrentStore(next: StrikeStore): void {
  setSingleton<StrikeStore>(STRIKESTORE_KEY, next);
}

export function getStrikeStore(): StrikeStore {
  return readCurrentStore();
}

export function setStrikeStore(store: StrikeStore): StrikeStore {
  const previous = readCurrentStore();
  writeCurrentStore(store);
  return previous;
}

export function resetStrikeStore(): void {
  writeCurrentStore(new InMemoryStrikeStore());
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. StrikeRecord fields are readonly. InMemoryStrikeStore works around this
//    by creating new objects via spread when marking expired.
//
// 2. getActiveStrikes excludes time-expired strikes (expires_at <= now), not just
//    those flagged `expired`, because the job that sets expired=true may not have
//    run yet. This is intentional double-checking.
//
// 3. Unlike ModerationStore, recordStrike returns {success, error} per L19.
//    The Sentinel must check this result and surface failures.
//
// 4. buildSummary assumes strikes are sorted newest-first. Both store
//    implementations sort by created_at DESC before building summary.
//
// 5. The SEVERITY_RANK map must match the one in guardian.ts. If severity
//    levels are ever changed, update both files.
