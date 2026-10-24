/**
 * platform/moderation/store.ts — Moderation audit persistence
 *
 * ADR-016: Full audit trail for every moderation decision.
 * ADR-053 D4: Postgres through platform/data, in the request's tenant.
 * P7: Provider-aware — swap via MODERATION_STORE env var.
 * P11: Store failures never block the moderation pipeline.
 *
 * Implementations:
 *   InMemoryModerationStore — for tests and development (default); one partition per tenant
 *   PostgresModerationStore — for production
 */

import type { ModerationStore, ModerationAuditRecord, AuditQueryOptions } from "./types";
import { logger } from "@/lib/logger";
import { withTenantTx } from "@/platform/data";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";

// ---------------------------------------------------------------------------
// InMemoryModerationStore
// ---------------------------------------------------------------------------

export class InMemoryModerationStore implements ModerationStore {
  private static readonly MAX_RECORDS = 10_000;
  /** One list per tenant (ADR-053 D6), so a tenant sees only its own records. */
  private readonly parts = new TenantPartitionedMap<"records", ModerationAuditRecord[]>();

  private get records(): ModerationAuditRecord[] {
    const part = this.parts.current();
    let list = part.get("records");
    if (!list) {
      list = [];
      part.set("records", list);
    }
    return list;
  }

  private set records(next: ModerationAuditRecord[]) {
    this.parts.current().set("records", next);
  }

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

  /** Test helper: the current tenant's record count. */
  getRecordCount(): number {
    return this.records.length;
  }

  /** Test helper: forget every tenant's records. */
  clear(): void {
    this.parts.clearAll();
  }
}

// ---------------------------------------------------------------------------
// PostgresModerationStore
// ---------------------------------------------------------------------------

/** One content_safety_audit row as pg returns it (timestamptz → Date, jsonb parsed). */
interface AuditRow {
  input_hash: string;
  direction: string;
  content_type: string;
  content_rating_level: number;
  user_id: string | null;
  triggered_by: string;
  classifier_output: unknown;
  categories_flagged: string[] | null;
  confidence: number;
  severity: string;
  action_taken: string;
  reasoning: string;
  severity_adjustment: number;
  context_factors: string[] | null;
  attribute_to_user: boolean;
  classifier_cost_usd: number;
  trajectory_id: string;
  agent_id: string;
  pipeline_latency_ms: number;
  request_id: string;
  created_at: Date | string;
}

/**
 * Audit records in content_safety_audit, in the request's tenant (row-level security keeps
 * each tenant's decisions apart; tenant_id is filled by its column default). Writes are
 * logged, never thrown (P11); reads that fail return nothing.
 */
export class PostgresModerationStore implements ModerationStore {
  async logAudit(record: ModerationAuditRecord): Promise<void> {
    try {
      await withTenantTx((tx) =>
        tx.query(
          `insert into content_safety_audit (
             input_hash, direction, content_type, content_rating_level, user_id, triggered_by,
             classifier_output, categories_flagged, confidence, severity, action_taken,
             reasoning, severity_adjustment, context_factors, attribute_to_user,
             classifier_cost_usd, trajectory_id, agent_id, pipeline_latency_ms, request_id,
             created_at)
           values ($1, $2::screening_direction, $3::content_type, $4, $5,
             $6::moderation_trigger, $7::jsonb, $8::text[], $9, $10, $11::moderation_action,
             $12, $13, $14::text[], $15, $16, $17, $18, $19, $20, $21::timestamptz)`,
          [
            record.inputHash,
            record.direction,
            record.contentType,
            record.contentRatingLevel,
            record.userId ?? null,
            record.triggeredBy,
            record.classifierOutput ? JSON.stringify(record.classifierOutput) : null,
            record.categoriesFlagged,
            record.confidence,
            record.severity,
            record.actionTaken,
            record.reasoning,
            record.severityAdjustment,
            record.contextFactors,
            record.attributeToUser,
            record.classifierCostUsd,
            record.trajectoryId,
            record.agentId,
            record.pipelineLatencyMs,
            record.requestId,
            record.timestamp,
          ]
        )
      );
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
      const limit = options?.limit && options.limit > 0 ? options.limit : null;
      const { rows } = await withTenantTx((tx) =>
        tx.query<AuditRow>(
          `select input_hash, direction, content_type, content_rating_level, user_id, triggered_by, classifier_output,
             categories_flagged, confidence, severity, action_taken, reasoning,
             severity_adjustment, context_factors, attribute_to_user, classifier_cost_usd,
             trajectory_id, agent_id, pipeline_latency_ms, request_id, created_at
             from content_safety_audit
            where ($1::moderation_action is null or action_taken = $1::moderation_action)
              and ($2::screening_direction is null or direction = $2::screening_direction)
              and ($3::content_type is null or content_type = $3::content_type)
              and ($4::integer is null or content_rating_level = $4::integer)
              and ($5::text is null or user_id = $5::text)
              and ($6::text is null or trajectory_id = $6::text)
              and ($7::timestamptz is null or created_at >= $7::timestamptz)
              and ($8::timestamptz is null or created_at < $8::timestamptz)
            order by created_at desc
            limit $9::integer`,
          [
            options?.actionTaken || null,
            options?.direction || null,
            options?.contentType || null,
            options?.contentRatingLevel ?? null,
            options?.userId || null,
            options?.trajectoryId || null,
            options?.since || null,
            options?.before || null,
            limit,
          ]
        )
      );
      return rows.map(mapRowToRecord);
    } catch {
      return [];
    }
  }

  async getByInputHash(inputHash: string): Promise<readonly ModerationAuditRecord[]> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<AuditRow>(
          `select input_hash, direction, content_type, content_rating_level, user_id, triggered_by, classifier_output,
             categories_flagged, confidence, severity, action_taken, reasoning,
             severity_adjustment, context_factors, attribute_to_user, classifier_cost_usd,
             trajectory_id, agent_id, pipeline_latency_ms, request_id, created_at
             from content_safety_audit
            where input_hash = $1
            order by created_at desc`,
          [inputHash]
        )
      );
      return rows.map(mapRowToRecord);
    } catch {
      return [];
    }
  }
}

function mapRowToRecord(row: AuditRow): ModerationAuditRecord {
  return {
    inputHash: row.input_hash,
    direction: row.direction as ModerationAuditRecord["direction"],
    contentType: row.content_type as ModerationAuditRecord["contentType"],
    contentRatingLevel:
      row.content_rating_level as ModerationAuditRecord["contentRatingLevel"],
    userId: row.user_id ?? undefined,
    triggeredBy: row.triggered_by as ModerationAuditRecord["triggeredBy"],
    classifierOutput: (row.classifier_output ?? undefined) as
      ModerationAuditRecord["classifierOutput"] | undefined,
    categoriesFlagged: row.categories_flagged ?? [],
    confidence: row.confidence,
    severity: row.severity,
    actionTaken: row.action_taken as ModerationAuditRecord["actionTaken"],
    reasoning: row.reasoning,
    severityAdjustment: row.severity_adjustment,
    contextFactors: row.context_factors ?? [],
    attributeToUser: row.attribute_to_user,
    classifierCostUsd: row.classifier_cost_usd,
    trajectoryId: row.trajectory_id,
    agentId: row.agent_id,
    pipelineLatencyMs: row.pipeline_latency_ms,
    requestId: row.request_id,
    timestamp:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}
// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const STORE_KEY = "platform.moderation.store";
function readCurrentStore(): ModerationStore {
  return getSingleton<ModerationStore>(STORE_KEY, () => new InMemoryModerationStore());
}
function writeCurrentStore(next: ModerationStore): void {
  setSingleton<ModerationStore>(STORE_KEY, next);
}

export function getModerationStore(): ModerationStore {
  return readCurrentStore();
}

export function setModerationStore(store: ModerationStore): ModerationStore {
  const previous = readCurrentStore();
  writeCurrentStore(store);
  return previous;
}

export function resetModerationStore(): void {
  writeCurrentStore(new InMemoryModerationStore());
}
