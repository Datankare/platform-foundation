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

// ═══════════════════════════════════════════════════════════════════════════
// Sprint 3b — Account Consequences + COPPA Enforcement Types
// ═══════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// Account status — maps to account_status enum in Migration 012
// ---------------------------------------------------------------------------

/**
 * User account status. Drives feature access and content restrictions.
 *
 *   active     — normal operation, no restrictions
 *   warned     — user has been warned, next violation escalates
 *   restricted — read-only mode, no content generation/modification
 *   suspended  — no platform access for a configured duration
 *   banned     — permanent ban, requires human review to lift
 */
export type AccountStatus = "active" | "warned" | "restricted" | "suspended" | "banned";

// ---------------------------------------------------------------------------
// Strike records — maps to user_strikes table in Migration 012
// ---------------------------------------------------------------------------

/**
 * A single strike record. Created by the Sentinel agent when the
 * Guardian blocks content and attributeToUser is true.
 *
 * Maps 1:1 to the user_strikes table.
 */
export interface StrikeRecord {
  readonly id: string;
  readonly userId: string;
  /** Safety category that triggered this strike */
  readonly category: string;
  /** Severity of the violation */
  readonly severity: SafetySeverity;
  /** Links to content_safety_audit record */
  readonly moderationAuditId: string | null;
  /** P18: Sentinel trajectory ID */
  readonly trajectoryId: string;
  /** P15: Sentinel agent ID */
  readonly agentId: string;
  /** Human-readable reason */
  readonly reason: string;
  /** When this strike expires (null = never) */
  readonly expiresAt: string | null;
  /** Whether this strike has expired */
  readonly expired: boolean;
  readonly createdAt: string;
}

/** Options for querying strikes */
export interface StrikeQueryOptions {
  readonly userId: string;
  /** Only active (non-expired) strikes */
  readonly activeOnly?: boolean;
  /** Filter by category */
  readonly category?: string;
  /** Limit results */
  readonly limit?: number;
}

/** Summary of a user's active strikes for consequence evaluation */
export interface StrikeSummary {
  /** Total active (non-expired) strikes */
  readonly totalActive: number;
  /** Active strikes per category */
  readonly byCategory: Readonly<Record<string, number>>;
  /** Most recent strike (for recency evaluation) */
  readonly mostRecent: StrikeRecord | null;
  /** Highest severity among active strikes */
  readonly highestSeverity: SafetySeverity | null;
}

// ---------------------------------------------------------------------------
// User account state — combines status + restrictions + strikes
// ---------------------------------------------------------------------------

/**
 * Full account state for a user. Loaded by the Sentinel and COPPA gate
 * to evaluate what actions are permitted.
 */
export interface UserAccountState {
  readonly userId: string;
  readonly accountStatus: AccountStatus;
  readonly restrictedUntil: string | null;
  readonly suspendedUntil: string | null;
  readonly bannedAt: string | null;
  readonly banReason: string | null;
  /** COPPA enforcement flag — true for under-13 without consent */
  readonly coppaEnforcementActive: boolean;
  readonly contentRatingLevel: ContentRatingLevel;
  /** Strike summary (populated on demand) */
  readonly strikeSummary?: StrikeSummary;
}

// ---------------------------------------------------------------------------
// Consequence actions — what the Sentinel decides
// ---------------------------------------------------------------------------

/**
 * Consequence action determined by the Sentinel after evaluating
 * strike history against thresholds.
 *
 *   none       — strike recorded, no status change needed
 *   warn       — set status to warned
 *   restrict   — set status to restricted (read-only for configured duration)
 *   suspend    — set status to suspended (no access for configured duration)
 *   ban        — set status to banned (permanent, requires human review)
 */
export type ConsequenceAction = "none" | "warn" | "restrict" | "suspend" | "ban";

// ---------------------------------------------------------------------------
// Sentinel result — returned by the Sentinel agent
// ---------------------------------------------------------------------------

/**
 * Result from the Sentinel agent after processing a block event.
 * Contains the strike record, consequence decision, and full trajectory.
 */
export interface SentinelResult {
  /** The strike that was recorded */
  readonly strike: StrikeRecord;
  /** User's updated strike summary */
  readonly strikeSummary: StrikeSummary;
  /** Consequence action taken (or none) */
  readonly consequenceAction: ConsequenceAction;
  /** Previous account status before this decision */
  readonly previousStatus: AccountStatus;
  /** New account status after this decision */
  readonly newStatus: AccountStatus;
  /** Human-readable reasoning chain */
  readonly reasoning: string;
  /** Sentinel trajectory ID (P18) */
  readonly trajectoryId: string;
  /** Sentinel agent ID (P15) */
  readonly agentId: string;
}

// ---------------------------------------------------------------------------
// COPPA gate result — returned by the consent gate
// ---------------------------------------------------------------------------

/**
 * Result from the COPPA consent gate check.
 *
 * The gate runs BEFORE the Guardian on every request for users
 * with coppa_enforcement_active = true.
 */
export interface CoppaGateResult {
  /** Whether the request is allowed to proceed */
  readonly allowed: boolean;
  /** Why the request was blocked (if not allowed) */
  readonly reason: string;
  /** Which feature was requested */
  readonly feature: string;
  /** User's content rating level */
  readonly contentRatingLevel: ContentRatingLevel;
  /** User's parental consent status */
  readonly consentStatus: string;
}

// ---------------------------------------------------------------------------
// Strike store — persistence interface (P7: provider-aware)
// ---------------------------------------------------------------------------

/**
 * StrikeStore — persistence interface for strike records.
 *
 * Implementations:
 *   InMemoryStrikeStore — for tests (default)
 *   SupabaseStrikeStore — for production
 *
 * Unlike ModerationStore, strike writes are NOT fire-and-forget.
 * Strike recording IS the primary function (L19). Failures must
 * be surfaced to the caller.
 */
export interface StrikeStore {
  /** Record a strike. Returns the created record or error. */
  recordStrike(
    strike: Omit<StrikeRecord, "id" | "createdAt">
  ): Promise<{ success: boolean; record?: StrikeRecord; error?: string }>;

  /** Get active strikes for a user. */
  getActiveStrikes(userId: string): Promise<readonly StrikeRecord[]>;

  /** Get strike summary for a user. */
  getStrikeSummary(userId: string): Promise<StrikeSummary>;

  /** Get all strikes for a user (including expired). */
  queryStrikes(options: StrikeQueryOptions): Promise<readonly StrikeRecord[]>;

  /** Mark expired strikes. Returns count of newly expired strikes. */
  expireStrikes(): Promise<number>;
}
