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

import type { ShownText } from "@/platform/errors/shown-text";
import { isRecordedFactor, isRecordedReasons, type RecordedReasons } from "./reasons";
import type { ModerationStore, ModerationAuditRecord, AuditQueryOptions } from "./types";
import { logger } from "@/lib/logger";
import { withTenantTx } from "@/platform/data";
import {
  asStoredKept,
  fromStoredKept,
  isOmittedMarker,
  jsonLimitError,
  notKeptReason,
  omittedMarker,
  storedJsonViolation,
  withinDatabaseBound,
  type NotKeptReason,
} from "@/platform/errors/json-limits";
import { recordMetricEvent } from "@/platform/observability/metric-event";
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

/**
 * A classifier's output (or a copy of it) as it is stored (platform TASK-229, review TA-a-4): the
 * value itself when it is within the stored-JSON bound; otherwise the "not kept" marker, logged
 * and counted (`moderation.output_not_kept`) — the decision is kept either way. `column` names
 * where it goes.
 */
export function storedClassifierJson(value: unknown, column: string): unknown {
  // A value that has the marker's own shape is stored wrapped, so a classifier's (a provider's)
  // answer is never read back as the platform's "not kept" marker (code review B-11).
  const kept = asStoredKept(value);
  const violation = withinDatabaseBound(kept);
  if (!violation) return kept;
  logger.warn("A classifier output is over the stored-JSON bound; stored as not kept", {
    field: column,
    code: violation.code,
    route: "platform/moderation/store",
  });
  recordMetricEvent(
    "moderation.output_not_kept",
    { count: 1 },
    { column, code: violation.code }
  );
  return omittedMarker(violation);
}

/**
 * `result` with its classifierOutput replaced by classifierOutputNotKept when the output is over
 * the stored-JSON bound (the rest of the result is the platform's own, small, fields).
 */
export function withClassifierOutputKept<
  T extends { classifierOutput?: unknown; classifierOutputNotKept?: unknown },
>(result: T, column: string): T {
  if (result.classifierOutput === undefined) return result;
  const stored = storedClassifierJson(result.classifierOutput, column);
  if (!isOmittedMarker(stored)) return result;
  const { classifierOutput: _dropped, ...rest } = result;
  void _dropped;
  return { ...rest, classifierOutputNotKept: stored._omitted } as T;
}

/** The fields of a moderation result that others shape, with what stands for each when not kept. */
const RESULT_FIELDS_NOT_KEPT_AS: Readonly<Record<string, unknown>> = {
  blocklistMatches: [],
  reasoning: [],
  contextFactors: [],
  severityAdjustment: 0,
  pipelineLatencyMs: 0,
  classifierCostUsd: 0,
};

/**
 * A moderation result as the review queue stores it (code review B-13): the decision's own
 * fields — action, triggeredBy, the trajectory — are always kept. The classifier's output over
 * the stored-JSON limits is replaced by classifierOutputNotKept (withClassifierOutputKept); if
 * the result is then still over them, each other field that is over them by itself (a long
 * blocklistMatches, a number out of range) — and, if that is not enough, each remaining list —
 * is replaced by its empty form and named in `fieldsNotKept` with the refusal's code, logged and
 * counted. Before, the whole result became the bare marker and read back with no action and no
 * trajectory. A result still over the limits after that (never seen: what is left is the
 * platform's own short fields) refuses the enqueue, coded — it is never stored as a marker.
 */
export function storableModerationResult<T extends object>(result: T, column: string): T {
  let out = withClassifierOutputKept(
    result as T & { classifierOutput?: unknown },
    column
  ) as T & Record<string, unknown>;
  let whole = storedJsonViolation(out);
  if (!whole) return out;
  const notKept: Record<string, { code: string; max?: number }> = {
    ...((out.fieldsNotKept as
      Record<string, { code: string; max?: number }> | undefined) ?? {}),
  };
  const drop = (field: string, reason: NotKeptReason) => {
    notKept[field] = reason;
    out = { ...out, [field]: RESULT_FIELDS_NOT_KEPT_AS[field], fieldsNotKept: notKept };
    logger.warn("A moderation result's field is over the stored-JSON bound; not kept", {
      field: `${column}.${field}`,
      code: reason.code,
      route: "platform/moderation/store",
    });
    recordMetricEvent(
      "moderation.output_not_kept",
      { count: 1 },
      { column: `${column}.${field}`, code: reason.code }
    );
  };
  for (const field of Object.keys(RESULT_FIELDS_NOT_KEPT_AS)) {
    if (!(field in out)) continue;
    const own = storedJsonViolation(out[field]);
    if (own) drop(field, notKeptReason(own));
  }
  whole = storedJsonViolation(out);
  for (const field of ["contextFactors", "reasoning", "blocklistMatches"]) {
    if (!whole) break;
    if (!(field in out) || field in notKept) continue;
    drop(field, notKeptReason(whole));
    whole = storedJsonViolation(out);
  }
  if (whole) throw jsonLimitError(whole, column);
  return out;
}

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
  reasoning_shown: unknown;
  severity_adjustment: number;
  context_factors: string[] | null;
  context_factors_shown: unknown;
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
             reasoning, reasoning_shown, severity_adjustment, context_factors,
             context_factors_shown, attribute_to_user, classifier_cost_usd, trajectory_id,
             agent_id, pipeline_latency_ms, request_id, created_at)
           values ($1, $2::screening_direction, $3::content_type, $4, $5,
             $6::moderation_trigger, $7::jsonb, $8::text[], $9, $10, $11::moderation_action,
             '', $12::jsonb, $13, '{}'::text[], $14::jsonb, $15, $16, $17, $18, $19, $20,
             $21::timestamptz)`,
          [
            record.inputHash,
            record.direction,
            record.contentType,
            record.contentRatingLevel,
            record.userId ?? null,
            record.triggeredBy,
            record.classifierOutput
              ? JSON.stringify(
                  storedClassifierJson(
                    record.classifierOutput,
                    "content_safety_audit.classifier_output"
                  )
                )
              : null,
            record.categoriesFlagged,
            record.confidence,
            record.severity,
            record.actionTaken,
            // The reasons and factors as catalog keys and values (TASK-209); the English columns
            // keep only what was recorded before them (migration 067).
            JSON.stringify(recordedArray(record.reasoning)),
            record.severityAdjustment,
            JSON.stringify(record.contextFactors.filter((f) => typeof f !== "string")),
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
             categories_flagged, confidence, severity, action_taken, reasoning, reasoning_shown,
             severity_adjustment, context_factors, context_factors_shown, attribute_to_user, classifier_cost_usd,
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
             categories_flagged, confidence, severity, action_taken, reasoning, reasoning_shown,
             severity_adjustment, context_factors, context_factors_shown, attribute_to_user, classifier_cost_usd,
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
    // An output that was not kept (TASK-229) is said so — never returned as an output.
    ...(isOmittedMarker(row.classifier_output)
      ? { classifierOutputNotKept: row.classifier_output._omitted }
      : {
          classifierOutput: (fromStoredKept(row.classifier_output) ?? undefined) as
            ModerationAuditRecord["classifierOutput"] | undefined,
        }),
    categoriesFlagged: row.categories_flagged ?? [],
    confidence: row.confidence,
    severity: row.severity,
    actionTaken: row.action_taken as ModerationAuditRecord["actionTaken"],
    // The keys when the row has them; a row recorded before them, its stored text (067).
    reasoning: isRecordedReasons(row.reasoning_shown)
      ? row.reasoning_shown
      : row.reasoning,
    severityAdjustment: row.severity_adjustment,
    contextFactors: [
      ...(Array.isArray(row.context_factors_shown)
        ? (row.context_factors_shown as unknown[]).filter(isRecordedFactor)
        : []),
      ...(row.context_factors ?? []),
    ],
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

/** Reasons to store as keys: a list as it is; a text recorded before them is not rewritten. */
function recordedArray(reasons: RecordedReasons): readonly ShownText[] {
  return typeof reasons === "string" ? [] : reasons;
}
