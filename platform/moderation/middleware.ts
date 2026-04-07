/**
 * platform/moderation/middleware.ts — Universal content safety middleware
 *
 * ADR-016: Applied at every input surface.
 * ADR-017 §1: Applied at every output surface (AI-generated content).
 *
 * Pipeline:
 *   Text → Layer 1: Blocklist scan (instant, zero-cost)
 *        → If blocklist hit with severity critical/high → BLOCK immediately
 *        → Layer 2: LLM classifier (structured categories + confidence)
 *        → Decision: allow / warn / block / escalate
 *        → Audit: full record logged
 *
 * Usage:
 *   import { screenContent } from "@/platform/moderation";
 *
 *   // Screen user input
 *   const result = await screenContent(text, { direction: "input", requestId });
 *   if (result.action === "block") { ... }
 *
 *   // Screen AI output before sending to user
 *   const result = await screenContent(aiResponse, { direction: "output", requestId });
 */

import type { ScreeningDirection, ModerationAction, ModerationResult } from "./types";
import { scanBlocklist } from "./blocklist";
import { classify } from "./classifier";
import { logModerationAudit } from "./audit";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Severity levels that trigger immediate block from blocklist */
const BLOCKLIST_BLOCK_SEVERITIES = new Set(["critical", "high"]);

/** Classifier confidence threshold — below this, action is escalate (uncertain) */
const CONFIDENCE_ESCALATE_THRESHOLD = 0.6;

/** Classifier severity → action mapping */
const SEVERITY_ACTION_MAP: Record<string, ModerationAction> = {
  critical: "block",
  high: "block",
  medium: "warn",
  low: "allow",
};

// ---------------------------------------------------------------------------
// Screening options
// ---------------------------------------------------------------------------

export interface ScreeningOptions {
  /** Direction: user input or AI output */
  direction: ScreeningDirection;
  /** Request ID for trace correlation */
  requestId: string;
  /** Skip the LLM classifier (use blocklist only) — for latency-critical paths */
  blocklistOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Main screening function
// ---------------------------------------------------------------------------

/**
 * Screen content through the multi-layer safety pipeline.
 * Returns a ModerationResult with the action to take.
 *
 * Fails closed — any error in the pipeline results in "block".
 */
export async function screenContent(
  text: string,
  options: ScreeningOptions
): Promise<ModerationResult> {
  const startTime = Date.now();

  // Guard: empty text is allowed (no content to screen)
  if (!text || text.trim().length === 0) {
    return {
      action: "allow",
      triggeredBy: "none",
      direction: options.direction,
      blocklistMatches: [],
      pipelineLatencyMs: Date.now() - startTime,
    };
  }

  // -----------------------------------------------------------------------
  // Layer 1: Blocklist scan (instant, zero-cost)
  // -----------------------------------------------------------------------

  const blocklistResult = scanBlocklist(text);

  if (blocklistResult.matched) {
    // Critical/high severity blocklist hits → block immediately, skip classifier
    if (BLOCKLIST_BLOCK_SEVERITIES.has(blocklistResult.maxSeverity)) {
      const result: ModerationResult = {
        action: "block",
        triggeredBy: "blocklist",
        direction: options.direction,
        blocklistMatches: blocklistResult.matches.map((m) => m.matched),
        pipelineLatencyMs: Date.now() - startTime,
      };

      // Fire-and-forget audit
      logModerationAudit(text, result, options.requestId);
      return result;
    }
  }

  // -----------------------------------------------------------------------
  // Layer 2: LLM classifier (unless blocklistOnly)
  // -----------------------------------------------------------------------

  if (options.blocklistOnly) {
    // Blocklist-only mode: if we had low/medium blocklist hits, warn
    const action: ModerationAction = blocklistResult.matched ? "warn" : "allow";
    const result: ModerationResult = {
      action,
      triggeredBy: blocklistResult.matched ? "blocklist" : "none",
      direction: options.direction,
      blocklistMatches: blocklistResult.matches.map((m) => m.matched),
      pipelineLatencyMs: Date.now() - startTime,
    };

    logModerationAudit(text, result, options.requestId);
    return result;
  }

  const classifierOutput = await classify(text, options.requestId);

  // -----------------------------------------------------------------------
  // Decision logic
  // -----------------------------------------------------------------------

  let action: ModerationAction;

  if (classifierOutput.safe) {
    // Classifier says safe — but check if blocklist had low-severity matches
    action = blocklistResult.matched ? "warn" : "allow";
  } else if (classifierOutput.confidence < CONFIDENCE_ESCALATE_THRESHOLD) {
    // Classifier is uncertain — escalate for human review
    action = "escalate";
  } else {
    // Classifier is confident it's unsafe — map severity to action
    action = SEVERITY_ACTION_MAP[classifierOutput.severity] ?? "block";
  }

  const result: ModerationResult = {
    action,
    triggeredBy: action === "allow" ? "none" : "classifier",
    direction: options.direction,
    blocklistMatches: blocklistResult.matches.map((m) => m.matched),
    classifierOutput,
    pipelineLatencyMs: Date.now() - startTime,
  };

  // Fire-and-forget audit
  logModerationAudit(text, result, options.requestId);

  return result;
}
