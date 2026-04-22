/**
 * platform/moderation/store.ts — Moderation audit persistence
 *
 * ADR-016: Full audit trail for every moderation decision.
 * P7: Provider-aware — swap via MODERATION_STORE env var.
 * P11: Store failures never block the moderation pipeline.
 *
 * Implementations:
 *   InMemoryModerationStore — for tests and development (default)
 *   SupabaseModerationStore — for production
 */

import type { ModerationStore, ModerationAuditRecord, AuditQueryOptions } from "./types";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// InMemoryModerationStore
// ---------------------------------------------------------------------------

export class InMemoryModerationStore implements ModerationStore {
  private static readonly MAX_RECORDS = 10_000;
  private records: ModerationAuditRecord[] = [];

  async logAudit(record: ModerationAuditRecord): Promise<void> {
    this.records.push({ ...record });
    if (this.records.length > InMemoryModerationStore.MAX_RECORDS) {
      this.records = this.records.slice(-InMemoryModerationStore.MAX_RECORDS);
    }
  }

  async queryAudits(
    options?: AuditQueryOptions
  ): Promise<readonly ModerationAuditRecord[]> {
    let filtered = [...this.records];

    if (options?.actionTaken) {
      filtered = filtered.filter((r) => r.actionTaken === options.actionTaken);
    }
    if (options?.direction) {
      filtered = filtered.filter((r) => r.direction === options.direction);
    }
    if (options?.contentType) {
      filtered = filtered.filter((r) => r.contentType === options.contentType);
    }
    if (options?.contentRatingLevel !== undefined) {
      filtered = filtered.filter(
        (r) => r.contentRatingLevel === options.contentRatingLevel
      );
    }
    if (options?.userId) {
      filtered = filtered.filter((r) => r.userId === options.userId);
    }
    if (options?.trajectoryId) {
      filtered = filtered.filter((r) => r.trajectoryId === options.trajectoryId);
    }
    if (options?.since) {
      filtered = filtered.filter((r) => r.timestamp >= options.since!);
    }
    if (options?.before) {
      filtered = filtered.filter((r) => r.timestamp < options.before!);
    }

    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (options?.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  async getByInputHash(inputHash: string): Promise<readonly ModerationAuditRecord[]> {
    return this.records.filter((r) => r.inputHash === inputHash);
  }

  /** Test helper */
  getRecordCount(): number {
    return this.records.length;
  }

  /** Test helper */
  clear(): void {
    this.records = [];
  }
}

// ---------------------------------------------------------------------------
// SupabaseModerationStore
// ---------------------------------------------------------------------------

export class SupabaseModerationStore implements ModerationStore {
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;

  constructor(supabaseUrl: string, supabaseKey: string) {
    if (typeof window !== "undefined") {
      throw new Error(
        "SupabaseModerationStore must not be instantiated client-side — service role key would leak"
      );
    }
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
  }

  async logAudit(record: ModerationAuditRecord): Promise<void> {
    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/content_safety_audit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          input_hash: record.inputHash,
          direction: record.direction,
          content_type: record.contentType,
          content_rating_level: record.contentRatingLevel,
          user_id: record.userId ?? null,
          triggered_by: record.triggeredBy,
          classifier_output: record.classifierOutput ?? null,
          categories_flagged: record.categoriesFlagged,
          confidence: record.confidence,
          severity: record.severity,
          action_taken: record.actionTaken,
          reasoning: record.reasoning,
          severity_adjustment: record.severityAdjustment,
          context_factors: record.contextFactors,
          attribute_to_user: record.attributeToUser,
          classifier_cost_usd: record.classifierCostUsd,
          trajectory_id: record.trajectoryId,
          agent_id: record.agentId,
          pipeline_latency_ms: record.pipelineLatencyMs,
          request_id: record.requestId,
          created_at: record.timestamp,
        }),
      });

      if (!response.ok) {
        logger.error("Moderation store: failed to persist audit record", {
          status: response.status,
          requestId: record.requestId,
          route: "platform/moderation/store",
        });
      }
    } catch (err) {
      logger.error("Moderation store: persistence error", {
        requestId: record.requestId,
        route: "platform/moderation/store",
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }

  async queryAudits(
    options?: AuditQueryOptions
  ): Promise<readonly ModerationAuditRecord[]> {
    try {
      const params = new URLSearchParams();
      params.set("order", "created_at.desc");

      if (options?.actionTaken) params.set("action_taken", `eq.${options.actionTaken}`);
      if (options?.direction) params.set("direction", `eq.${options.direction}`);
      if (options?.contentType) params.set("content_type", `eq.${options.contentType}`);
      if (options?.contentRatingLevel !== undefined) {
        params.set("content_rating_level", `eq.${options.contentRatingLevel}`);
      }
      if (options?.userId) params.set("user_id", `eq.${options.userId}`);
      if (options?.trajectoryId)
        params.set("trajectory_id", `eq.${options.trajectoryId}`);
      if (options?.since) params.set("created_at", `gte.${options.since}`);
      if (options?.before) params.append("created_at", `lt.${options.before}`);
      if (options?.limit && options.limit > 0) params.set("limit", String(options.limit));

      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/content_safety_audit?${params.toString()}`,
        {
          method: "GET",
          headers: {
            apikey: this.supabaseKey,
            Authorization: `Bearer ${this.supabaseKey}`,
          },
        }
      );

      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows) ? rows.map(mapRowToRecord) : [];
    } catch {
      return [];
    }
  }

  async getByInputHash(inputHash: string): Promise<readonly ModerationAuditRecord[]> {
    try {
      const params = new URLSearchParams();
      params.set("input_hash", `eq.${inputHash}`);
      params.set("order", "created_at.desc");

      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/content_safety_audit?${params.toString()}`,
        {
          method: "GET",
          headers: {
            apikey: this.supabaseKey,
            Authorization: `Bearer ${this.supabaseKey}`,
          },
        }
      );

      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows) ? rows.map(mapRowToRecord) : [];
    } catch {
      return [];
    }
  }
}

function mapRowToRecord(row: Record<string, unknown>): ModerationAuditRecord {
  return {
    inputHash: String(row.input_hash ?? ""),
    direction: (row.direction as ModerationAuditRecord["direction"]) ?? "input",
    contentType:
      (row.content_type as ModerationAuditRecord["contentType"]) ?? "generation",
    contentRatingLevel:
      typeof row.content_rating_level === "number"
        ? (row.content_rating_level as ModerationAuditRecord["contentRatingLevel"])
        : 1,
    userId: row.user_id ? String(row.user_id) : undefined,
    triggeredBy: (row.triggered_by as ModerationAuditRecord["triggeredBy"]) ?? "none",
    classifierOutput: row.classifier_output as
      | ModerationAuditRecord["classifierOutput"]
      | undefined,
    categoriesFlagged: Array.isArray(row.categories_flagged)
      ? (row.categories_flagged as string[])
      : [],
    confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
    severity: String(row.severity ?? "low"),
    actionTaken: (row.action_taken as ModerationAuditRecord["actionTaken"]) ?? "allow",
    reasoning: String(row.reasoning ?? ""),
    severityAdjustment:
      typeof row.severity_adjustment === "number" ? row.severity_adjustment : 0,
    contextFactors: Array.isArray(row.context_factors)
      ? (row.context_factors as string[])
      : [],
    attributeToUser: row.attribute_to_user !== false,
    classifierCostUsd:
      typeof row.classifier_cost_usd === "number" ? row.classifier_cost_usd : 0,
    trajectoryId: String(row.trajectory_id ?? ""),
    agentId: String(row.agent_id ?? ""),
    pipelineLatencyMs:
      typeof row.pipeline_latency_ms === "number" ? row.pipeline_latency_ms : 0,
    requestId: String(row.request_id ?? ""),
    timestamp: String(row.created_at ?? new Date().toISOString()),
  };
}

// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

let currentStore: ModerationStore = new InMemoryModerationStore();

export function getModerationStore(): ModerationStore {
  return currentStore;
}

export function setModerationStore(store: ModerationStore): ModerationStore {
  const previous = currentStore;
  currentStore = store;
  return previous;
}

export function resetModerationStore(): void {
  currentStore = new InMemoryModerationStore();
}
