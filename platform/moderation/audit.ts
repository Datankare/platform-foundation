/**
 * platform/moderation/audit.ts — Content safety audit trail
 *
 * ADR-016: Every moderation decision permanently logged with full
 * classifier output, confidence, severity, action, and direction.
 *
 * Currently logs via structured logger. Phase 4 adds database persistence
 * with the content_safety_audit table.
 *
 * Privacy: input content is SHA-256 hashed — raw content never stored.
 */

import type { ModerationAuditRecord, ModerationResult } from "./types";
import { logger } from "@/lib/logger";

/**
 * Create a SHA-256 hash of the input text.
 * Uses the Web Crypto API (available in Node.js 18+).
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
    triggeredBy: result.triggeredBy,
    classifierOutput: result.classifierOutput,
    categoriesFlagged: result.classifierOutput?.categories ?? [],
    confidence: result.classifierOutput?.confidence ?? 1.0,
    severity: result.classifierOutput?.severity ?? "low",
    actionTaken: result.action,
    pipelineLatencyMs: result.pipelineLatencyMs,
    requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Log a moderation audit record.
 * Fire-and-forget — audit failures are logged but never block the operation.
 *
 * Phase 4: this will also write to the content_safety_audit database table.
 */
export async function logModerationAudit(
  text: string,
  result: ModerationResult,
  requestId: string
): Promise<void> {
  try {
    const record = await buildAuditRecord(text, result, requestId);

    logger.info("moderation_audit", {
      message: `Safety ${result.direction}: ${result.action} (${result.triggeredBy})`,
      requestId,
      inputHash: record.inputHash,
      direction: record.direction,
      triggeredBy: record.triggeredBy,
      categoriesFlagged: record.categoriesFlagged.join(",") || "none",
      confidence: record.confidence,
      severity: record.severity,
      actionTaken: record.actionTaken,
      pipelineLatencyMs: record.pipelineLatencyMs,
    });
  } catch (err) {
    // Audit failure must never block the pipeline
    logger.error("Moderation audit logging failed", {
      requestId,
      route: "platform/moderation/audit",
      error: err instanceof Error ? err.message : "Unknown",
    });
  }
}
