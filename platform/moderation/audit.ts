/**
 * platform/moderation/audit.ts — Content safety audit trail
 *
 * ADR-016: Every moderation decision permanently logged.
 * Dual-write: structured logger + ModerationStore.
 * Privacy: input content is SHA-256 hashed — raw content never stored.
 * P11: Audit failures must never block the moderation pipeline.
 */

import type { ModerationAuditRecord, ModerationResult } from "./types";
import { getModerationStore } from "./store";
import { logger } from "@/lib/logger";

/**
 * Create a SHA-256 hash of the input text.
 */
export async function hashInput(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build an audit record from a moderation result.
 */
export async function buildAuditRecord(
  text: string,
  result: ModerationResult,
  requestId: string
): Promise<ModerationAuditRecord> {
  return {
    inputHash: await hashInput(text),
    direction: result.direction,
    contentType: result.contentType,
    contentRatingLevel: result.contentRatingLevel,
    triggeredBy: result.triggeredBy,
    classifierOutput: result.classifierOutput,
    categoriesFlagged: result.classifierOutput?.categories ?? [],
    confidence: result.classifierOutput?.confidence ?? 1.0,
    severity: result.classifierOutput?.severity ?? "low",
    actionTaken: result.action,
    reasoning: result.reasoning,
    severityAdjustment: result.severityAdjustment,
    contextFactors: result.contextFactors,
    attributeToUser: result.attributeToUser,
    classifierCostUsd: result.classifierCostUsd,
    trajectoryId: result.trajectoryId,
    agentId: result.agentId,
    pipelineLatencyMs: result.pipelineLatencyMs,
    requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Log a moderation audit record via dual-write (logger + store).
 * Fire-and-forget — audit failures never block the pipeline.
 */
export async function logModerationAudit(
  text: string,
  result: ModerationResult,
  requestId: string
): Promise<void> {
  try {
    const record = await buildAuditRecord(text, result, requestId);

    // Write 1: Structured logger (always)
    logger.info("moderation_audit", {
      message: `Safety ${result.direction}: ${result.action} (${result.triggeredBy})`,
      requestId,
      inputHash: record.inputHash,
      direction: record.direction,
      contentType: record.contentType,
      contentRatingLevel: record.contentRatingLevel,
      triggeredBy: record.triggeredBy,
      categoriesFlagged: record.categoriesFlagged.join(",") || "none",
      confidence: record.confidence,
      severity: record.severity,
      actionTaken: record.actionTaken,
      reasoning: record.reasoning,
      severityAdjustment: record.severityAdjustment,
      trajectoryId: record.trajectoryId,
      agentId: record.agentId,
      pipelineLatencyMs: record.pipelineLatencyMs,
    });

    // Write 2: ModerationStore (fire-and-forget)
    try {
      await getModerationStore().logAudit(record);
    } catch (storeErr) {
      logger.error("Moderation audit store write failed — logger write succeeded", {
        requestId,
        route: "platform/moderation/audit",
        error: storeErr instanceof Error ? storeErr.message : "Unknown",
      });
    }
  } catch (err) {
    logger.error("Moderation audit logging failed", {
      requestId,
      route: "platform/moderation/audit",
      error: err instanceof Error ? err.message : "Unknown",
    });
  }
}
