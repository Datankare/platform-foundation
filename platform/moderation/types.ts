/**
 * platform/moderation/types.ts — Content safety types
 *
 * ADR-016: Multi-layer defense architecture.
 * ADR-017: Input AND output screening.
 *
 * Shared types for blocklist, classifier, middleware, and audit.
 */

// Re-export classifier types from prompt (single source of truth)
export type {
  SafetyCategory,
  SafetySeverity,
  ClassifierOutput,
} from "@/prompts/safety/classify-v1";

// ---------------------------------------------------------------------------
// Screening direction — input vs output (ADR-017 §1)
// ---------------------------------------------------------------------------

/** Whether we're screening user input or AI-generated output */
export type ScreeningDirection = "input" | "output";

// ---------------------------------------------------------------------------
// Moderation decision
// ---------------------------------------------------------------------------

/** Action taken after screening */
export type ModerationAction = "allow" | "warn" | "block" | "escalate";

/** Full moderation result — returned by the middleware pipeline */
export interface ModerationResult {
  /** Final action */
  action: ModerationAction;
  /** Which layer triggered the decision */
  triggeredBy: "blocklist" | "classifier" | "none";
  /** Direction: input from user or output from AI */
  direction: ScreeningDirection;
  /** Blocklist matches (if any) */
  blocklistMatches: string[];
  /** Classifier output (if classifier was invoked) */
  classifierOutput?: ClassifierOutput;
  /** Latency of the full pipeline in ms */
  pipelineLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Audit record — per ADR-016 audit trail requirements
// ---------------------------------------------------------------------------

import type { ClassifierOutput } from "@/prompts/safety/classify-v1";

/** What gets logged for every moderation decision */
export interface ModerationAuditRecord {
  /** SHA-256 hash of input — not raw content, for privacy */
  inputHash: string;
  /** Screening direction */
  direction: ScreeningDirection;
  /** Which layer triggered */
  triggeredBy: "blocklist" | "classifier" | "none";
  /** Full classifier output (if invoked) */
  classifierOutput?: ClassifierOutput;
  /** Categories flagged (convenience — also in classifierOutput) */
  categoriesFlagged: string[];
  /** Confidence score (0–1) */
  confidence: number;
  /** Severity level */
  severity: string;
  /** Action taken */
  actionTaken: ModerationAction;
  /** Pipeline latency */
  pipelineLatencyMs: number;
  /** Request ID for trace correlation */
  requestId: string;
  /** Timestamp */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Blocklist types
// ---------------------------------------------------------------------------

/** A blocklist pattern — can be exact match or regex */
export interface BlocklistPattern {
  /** Unique identifier */
  id: string;
  /** The pattern string */
  pattern: string;
  /** Match type */
  type: "exact" | "substring" | "regex";
  /** Which safety category this pattern maps to */
  category: string;
  /** Severity if matched */
  severity: string;
}
