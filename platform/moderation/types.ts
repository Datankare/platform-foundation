/**
 * platform/moderation/types.ts — Content safety types
 *
 * ADR-016: Multi-layer defense architecture.
 * ADR-017: Input AND output screening.
 *
 * Shared types for the Guardian agent, blocklist, classifier, content
 * rating, middleware, audit, and moderation store.
 */

// Re-export classifier types from prompt (single source of truth)
export type {
  SafetyCategory,
  SafetySeverity,
  ClassifierOutput,
} from "@/prompts/safety/classify-v1";

import type { ClassifierOutput, SafetySeverity } from "@/prompts/safety/classify-v1";
import type { AgentIdentity } from "@/platform/agents/types";

// ---------------------------------------------------------------------------
// Content rating levels — from platform/auth/coppa.ts
// ---------------------------------------------------------------------------

/**
 * Content rating level per COPPA age evaluation.
 *   1 = under 13 (COPPA applies, strictest)
 *   2 = 13–17 (teen, moderate)
 *   3 = 18+ (adult, standard)
 */
export type ContentRatingLevel = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Content type — what kind of content is being screened
// ---------------------------------------------------------------------------

/**
 * The kind of content being screened. Affects severity adjustments.
 *
 * translation   — user is translating existing content (higher tolerance)
 * generation    — user is creating new content (standard)
 * transcription — user is transcribing speech (higher tolerance, STT artifacts)
 * extraction    — user uploaded a document (content is not theirs)
 * profile       — display name, bio (stricter for URLs/impersonation)
 * social        — chat messages, group posts (standard + context)
 * ai-output     — AI-generated response (no user strikes on block)
 */
export type ContentType =
  | "translation"
  | "generation"
  | "transcription"
  | "extraction"
  | "profile"
  | "social"
  | "ai-output";

// ---------------------------------------------------------------------------
// Screening direction — input vs output (ADR-017 §1)
// ---------------------------------------------------------------------------

/** Whether we're screening user input or AI-generated output */
export type ScreeningDirection = "input" | "output";

// ---------------------------------------------------------------------------
// User history summary — for context-aware decisions
// ---------------------------------------------------------------------------

/** Summary of a user's moderation history for contextual decisions */
export interface UserModerationHistory {
  /** Total number of screenings for this user */
  readonly totalScreenings: number;
  /** Number of flags in the last 24 hours */
  readonly recentFlags: number;
  /** Number of active (non-expired) strikes */
  readonly activeStrikes: number;
  /** Last flagged category (for pattern detection) */
  readonly lastFlagCategory?: string;
}

// ---------------------------------------------------------------------------
// Screening context — rich context for the Guardian agent
// ---------------------------------------------------------------------------

/**
 * Rich context for content screening. Enables the Guardian agent to
 * make contextually aware decisions rather than blind classification.
 *
 * All fields except contentType are optional — callers provide what
 * they know, the Guardian works with what it gets.
 */
export interface ScreeningContext {
  /** What kind of content is being screened */
  readonly contentType: ContentType;
  /** User's content rating level (defaults to 1 = strictest if unknown) */
  readonly contentRatingLevel?: ContentRatingLevel;
  /** User ID (for history lookup and strike attribution) */
  readonly userId?: string;
  /** User's moderation history (populated by caller or looked up) */
  readonly userHistory?: UserModerationHistory;
  /** Session ID (for session-level tracking) */
  readonly sessionId?: string;
  /** Source language (context for translation content) */
  readonly sourceLanguage?: string;
  /** Target language (context for translation content) */
  readonly targetLanguage?: string;
  /** Which agent requested this screening (delegation chain) */
  readonly requestedBy?: AgentIdentity;
}

// ---------------------------------------------------------------------------
// Moderation decision
// ---------------------------------------------------------------------------

/** Action taken after screening */
export type ModerationAction = "allow" | "warn" | "block" | "escalate";

/** Full moderation result — returned by the Guardian agent */
export interface ModerationResult {
  /** Final action */
  action: ModerationAction;
  /** Which layer triggered the decision */
  triggeredBy: "blocklist" | "classifier" | "content-rating" | "context" | "none";
  /** Direction: input from user or output from AI */
  direction: ScreeningDirection;
  /** Content type screened */
  contentType: ContentType;
  /** Content rating level applied */
  contentRatingLevel: ContentRatingLevel;
  /** Blocklist matches (if any) */
  blocklistMatches: string[];
  /** Classifier output (if classifier was invoked) */
  classifierOutput?: ClassifierOutput;
  /** Human-readable reasoning chain for the decision */
  reasoning: string;
  /** Severity adjustment applied (negative = reduced severity) */
  severityAdjustment: number;
  /** Context factors that influenced the decision */
  contextFactors: string[];
  /** Whether user strikes should be attributed (false for ai-output) */
  attributeToUser: boolean;
  /** Latency of the full pipeline in ms */
  pipelineLatencyMs: number;
  /** Classifier cost in USD */
  classifierCostUsd: number;
  /** Guardian trajectory ID */
  trajectoryId: string;
  /** Guardian agent ID */
  agentId: string;
}

// ---------------------------------------------------------------------------
// Audit record — per ADR-016 audit trail requirements
// ---------------------------------------------------------------------------

/** What gets logged for every moderation decision */
export interface ModerationAuditRecord {
  /** SHA-256 hash of input — not raw content, for privacy */
  inputHash: string;
  /** Screening direction */
  direction: ScreeningDirection;
  /** Content type screened */
  contentType: ContentType;
  /** Content rating level applied */
  contentRatingLevel: ContentRatingLevel;
  /** User ID (if known) */
  userId?: string;
  /** Which layer triggered */
  triggeredBy: ModerationResult["triggeredBy"];
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
  /** Human-readable reasoning chain */
  reasoning: string;
  /** Severity adjustment applied */
  severityAdjustment: number;
  /** Context factors */
  contextFactors: string[];
  /** Whether user strikes were attributed */
  attributeToUser: boolean;
  /** Classifier cost in USD */
  classifierCostUsd: number;
  /** Guardian trajectory ID (P18) */
  trajectoryId: string;
  /** Guardian agent ID (P15) */
  agentId: string;
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

/** A blocklist pattern — exact word, substring, or validated regex */
export interface BlocklistPattern {
  /** Unique identifier */
  id: string;
  /** The pattern string */
  pattern: string;
  /** Match type: "exact" = word boundary, "substring" = contains, "regex" = validated safe regex */
  type: "exact" | "substring" | "regex";
  /** Which safety category this pattern maps to */
  category: string;
  /** Severity if matched */
  severity: string;
}

// ---------------------------------------------------------------------------
// Content rating thresholds (loaded from config)
// ---------------------------------------------------------------------------

/** Thresholds that control severity-to-action mapping per rating level */
export interface ContentRatingThresholds {
  /** Content rating level */
  readonly level: ContentRatingLevel;
  /** Label for logging */
  readonly label: string;
  /** Minimum severity that triggers a block */
  readonly blockSeverity: SafetySeverity;
  /** Minimum severity that triggers a warn */
  readonly warnSeverity: SafetySeverity;
  /** Confidence threshold — below this, escalate */
  readonly escalateBelow: number;
}

// ---------------------------------------------------------------------------
// Moderation store — persistence interface (P7: provider-aware)
// ---------------------------------------------------------------------------

/** Options for querying audit records */
export interface AuditQueryOptions {
  /** Filter by action taken */
  actionTaken?: ModerationAction;
  /** Filter by direction */
  direction?: ScreeningDirection;
  /** Filter by content type */
  contentType?: ContentType;
  /** Filter by content rating level */
  contentRatingLevel?: ContentRatingLevel;
  /** Filter by user ID */
  userId?: string;
  /** Filter by trajectory ID */
  trajectoryId?: string;
  /** Return records after this ISO timestamp */
  since?: string;
  /** Return records before this ISO timestamp */
  before?: string;
  /** Maximum number of results */
  limit?: number;
}

/**
 * ModerationStore — persistence interface for moderation audit records.
 *
 * Implementations:
 *   InMemoryModerationStore — for tests (default)
 *   SupabaseModerationStore — for production
 *
 * Store failures must never block the moderation pipeline (P11).
 */
export interface ModerationStore {
  /** Persist an audit record. Fire-and-forget — failures are logged, not thrown. */
  logAudit(record: ModerationAuditRecord): Promise<void>;

  /** Query audit records with optional filters. */
  queryAudits(options?: AuditQueryOptions): Promise<readonly ModerationAuditRecord[]>;

  /** Get audit records by input hash — for deduplication and history. */
  getByInputHash(inputHash: string): Promise<readonly ModerationAuditRecord[]>;
}
