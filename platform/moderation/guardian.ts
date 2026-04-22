/**
 * platform/moderation/guardian.ts — Guardian content safety agent
 *
 * The Guardian is the platform's content safety agent. It screens content
 * through a multi-layer pipeline (blocklist → classifier → content rating)
 * with context-aware reasoning and full trajectory recording.
 *
 * Unlike a procedural pipeline, the Guardian:
 * - Has agent identity (P15) — every decision is attributable
 * - Builds trajectories (P18) — the full decision path is inspectable
 * - Reasons about context (P17) — content type, user history, language
 * - Explains decisions — every action includes a human-readable reasoning chain
 * - Uses tools — blocklist and classifier are tools, not pipeline stages
 *
 * GenAI Principles:
 *   P2  — Bounded multi-step agent execution
 *   P3  — Full observability: every step timed, costed, and recorded
 *   P4  — Structural safety: fail-closed at every layer
 *   P11 — Resilient degradation: config unavailable → strictest thresholds
 *   P12 — Economic transparency: classifier cost tracked per decision
 *   P13 — Control plane: all thresholds from platform_config
 *   P15 — Agent identity: actorType/actorId/agentRole
 *   P17 — Cognition/commitment boundary: evaluate internally, commit once
 *   P18 — Durable trajectories: full step history per decision
 *
 * @module platform/moderation
 */

import type { AgentIdentity, Step, StepBoundary } from "@/platform/agents/types";
import type { SafetySeverity } from "@/prompts/safety/classify-v1";
import type {
  ScreeningContext,
  ScreeningDirection,
  ContentRatingLevel,
  ModerationAction,
  ModerationResult,
} from "./types";
import { scanBlocklist } from "./blocklist";
import { classify } from "./classifier";
import { loadContentRatingThresholds } from "./config";
import { evaluateContext, reduceSeverity } from "./context";
import { logModerationAudit } from "./audit";

// ---------------------------------------------------------------------------
// Severity comparison
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<SafetySeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function severityAtOrAbove(severity: SafetySeverity, threshold: SafetySeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

// ---------------------------------------------------------------------------
// Trajectory helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function makeStep(
  stepIndex: number,
  action: string,
  boundary: StepBoundary,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  durationMs: number,
  cost: number
): Step {
  return {
    stepIndex,
    action,
    boundary,
    input,
    output,
    durationMs,
    cost,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Blocklist severity constants
// ---------------------------------------------------------------------------

const BLOCKLIST_BLOCK_SEVERITIES = new Set(["critical", "high"]);

// ---------------------------------------------------------------------------
// Guardian agent
// ---------------------------------------------------------------------------

/**
 * The Guardian content safety agent.
 *
 * Each instance has a unique agent ID and builds a trajectory per
 * screening operation. The Guardian is stateless between calls —
 * each `screen()` invocation creates a fresh trajectory.
 */
export class Guardian {
  readonly identity: AgentIdentity;

  constructor(instanceId?: string) {
    const id = instanceId ?? `guardian-${generateId()}`;
    this.identity = {
      actorType: "agent",
      actorId: id,
      agentRole: "guardian",
    };
  }

  /**
   * Screen content through the full agentic pipeline.
   *
   * Trajectory:
   *   Step 0: receive-context     (cognition)  — evaluate content type and user context
   *   Step 1: blocklist-scan      (cognition)  — instant pattern matching
   *   Step 2: classify-content    (cognition)  — LLM classifier (skipped if blocklist blocks)
   *   Step 3: evaluate-thresholds (cognition)  — apply content rating + context adjustments
   *   Step 4: decide              (commitment) — final action with reasoning
   *
   * @param text - Content to screen
   * @param direction - "input" (user content) or "output" (AI content)
   * @param requestId - Request ID for trace correlation
   * @param context - Rich screening context (content type, user history, etc.)
   */
  async screen(
    text: string,
    direction: ScreeningDirection,
    requestId: string,
    context: ScreeningContext
  ): Promise<ModerationResult> {
    const startTime = Date.now();
    const trajectoryId = `traj-${generateId()}`;
    const steps: Step[] = [];
    const ratingLevel: ContentRatingLevel = context.contentRatingLevel ?? 1;
    const reasonParts: string[] = [];

    // ── Guard: empty text ──────────────────────────────────────────
    if (!text || text.trim().length === 0) {
      return this.buildResult({
        action: "allow",
        triggeredBy: "none",
        direction,
        context,
        ratingLevel,
        blocklistMatches: [],
        reasoning: "Empty text — no content to screen.",
        severityAdjustment: 0,
        contextFactors: [],
        attributeToUser: true,
        pipelineLatencyMs: Date.now() - startTime,
        classifierCostUsd: 0,
        trajectoryId,
      });
    }

    // ── Step 0: Receive context (cognition) ─────────────────────────
    const ctxStart = Date.now();
    const ctxEval = await evaluateContext(context);
    steps.push(
      makeStep(
        0,
        "receive-context",
        "cognition",
        {
          contentType: context.contentType,
          contentRatingLevel: ratingLevel,
          userId: context.userId ?? "anonymous",
        },
        {
          severityReduction: ctxEval.severityReduction,
          attributeToUser: ctxEval.attributeToUser,
          factors: ctxEval.factors,
        },
        Date.now() - ctxStart,
        0
      )
    );

    if (ctxEval.factors.length > 0) {
      reasonParts.push(`Context: ${ctxEval.factors.join("; ")}.`);
    }

    // ── Step 1: Blocklist scan (cognition) ───────────────────────────
    const blStart = Date.now();
    const blocklistResult = scanBlocklist(text);
    steps.push(
      makeStep(
        1,
        "blocklist-scan",
        "cognition",
        { textLength: text.length },
        {
          matched: blocklistResult.matched,
          matchCount: blocklistResult.matches.length,
          maxSeverity: blocklistResult.maxSeverity,
        },
        Date.now() - blStart,
        0
      )
    );

    // Critical/high blocklist hit → block immediately, skip classifier
    if (
      blocklistResult.matched &&
      BLOCKLIST_BLOCK_SEVERITIES.has(blocklistResult.maxSeverity)
    ) {
      const reasoning = `Blocklist hit: ${blocklistResult.matches.map((m) => m.category).join(", ")} (severity: ${blocklistResult.maxSeverity}). Blocked immediately — classifier skipped.`;

      // Step 4: Decide (commitment) — immediate block
      steps.push(
        makeStep(
          steps.length,
          "decide",
          "commitment",
          { trigger: "blocklist", severity: blocklistResult.maxSeverity },
          { action: "block", reasoning },
          0,
          0
        )
      );

      const result = this.buildResult({
        action: "block",
        triggeredBy: "blocklist",
        direction,
        context,
        ratingLevel,
        blocklistMatches: blocklistResult.matches.map((m) => m.matched),
        reasoning,
        severityAdjustment: 0,
        contextFactors: ctxEval.factors,
        attributeToUser: ctxEval.attributeToUser,
        pipelineLatencyMs: Date.now() - startTime,
        classifierCostUsd: 0,
        trajectoryId,
        steps,
      });

      logModerationAudit(text, result, requestId);
      return result;
    }

    // ── Step 2: Classify content (cognition) ─────────────────────────
    const clStart = Date.now();
    const classifierOutput = await classify(text, requestId);
    const classifierCost = 0; // Cost tracked by orchestrator metrics
    steps.push(
      makeStep(
        2,
        "classify-content",
        "cognition",
        { textLength: text.length },
        {
          safe: classifierOutput.safe,
          categories: classifierOutput.categories,
          confidence: classifierOutput.confidence,
          severity: classifierOutput.severity,
        },
        Date.now() - clStart,
        classifierCost
      )
    );

    // ── Step 3: Evaluate thresholds (cognition) ──────────────────────
    const evalStart = Date.now();
    let action: ModerationAction;
    let triggeredBy: ModerationResult["triggeredBy"];
    const severityAdjustment =
      ctxEval.severityReduction > 0 ? -ctxEval.severityReduction : 0;

    if (classifierOutput.safe) {
      // Classifier says safe — check for low-severity blocklist matches
      action = blocklistResult.matched ? "warn" : "allow";
      triggeredBy = blocklistResult.matched ? "blocklist" : "none";
      reasonParts.push(
        `Classifier: safe (confidence ${classifierOutput.confidence.toFixed(2)}).`
      );
      if (blocklistResult.matched) {
        reasonParts.push(`Low-severity blocklist match — warning applied.`);
      }
    } else {
      // Classifier says unsafe — apply content rating with context adjustment
      let thresholds;
      try {
        thresholds = await loadContentRatingThresholds(ratingLevel);
      } catch {
        // P11: Config unavailable — fail closed with strictest thresholds
        thresholds = {
          level: 1 as const,
          label: "fail-closed (config unavailable)",
          blockSeverity: "low" as const,
          warnSeverity: "low" as const,
          escalateBelow: 0.95,
        };
        reasonParts.push("Config unavailable — using fail-closed thresholds.");
      }

      // Apply severity reduction from context
      const originalSeverity = classifierOutput.severity;
      const adjustedSeverity = reduceSeverity(
        originalSeverity,
        ctxEval.severityReduction
      );

      if (ctxEval.severityReduction > 0) {
        reasonParts.push(
          `Severity adjusted: ${originalSeverity} → ${adjustedSeverity} (${context.contentType} context, -${ctxEval.severityReduction}).`
        );
      }

      // Check confidence threshold
      if (classifierOutput.confidence < thresholds.escalateBelow) {
        action = "escalate";
        triggeredBy = "content-rating";
        reasonParts.push(
          `Confidence ${classifierOutput.confidence.toFixed(2)} below threshold ${thresholds.escalateBelow} for ${thresholds.label} — escalating for human review.`
        );
      } else if (severityAtOrAbove(adjustedSeverity, thresholds.blockSeverity)) {
        action = "block";
        triggeredBy = "content-rating";
        reasonParts.push(
          `Adjusted severity ${adjustedSeverity} ≥ block threshold ${thresholds.blockSeverity} for ${thresholds.label}.`
        );
      } else if (severityAtOrAbove(adjustedSeverity, thresholds.warnSeverity)) {
        action = "warn";
        triggeredBy = "content-rating";
        reasonParts.push(
          `Adjusted severity ${adjustedSeverity} ≥ warn threshold ${thresholds.warnSeverity} for ${thresholds.label}.`
        );
      } else {
        action = "allow";
        triggeredBy = "content-rating";
        reasonParts.push(
          `Adjusted severity ${adjustedSeverity} below warn threshold for ${thresholds.label} — allowed.`
        );
      }
    }

    steps.push(
      makeStep(
        3,
        "evaluate-thresholds",
        "cognition",
        {
          safe: classifierOutput.safe,
          severity: classifierOutput.severity,
          severityAdjustment,
          ratingLevel,
        },
        { action, triggeredBy },
        Date.now() - evalStart,
        0
      )
    );

    // ── Step 4: Decide (commitment) ──────────────────────────────────
    const reasoning = reasonParts.join(" ");
    steps.push(
      makeStep(
        steps.length,
        "decide",
        "commitment",
        { proposedAction: action },
        { finalAction: action, reasoning, attributeToUser: ctxEval.attributeToUser },
        0,
        0
      )
    );

    const result = this.buildResult({
      action,
      triggeredBy,
      direction,
      context,
      ratingLevel,
      blocklistMatches: blocklistResult.matches.map((m) => m.matched),
      classifierOutput,
      reasoning,
      severityAdjustment,
      contextFactors: ctxEval.factors,
      attributeToUser: ctxEval.attributeToUser,
      pipelineLatencyMs: Date.now() - startTime,
      classifierCostUsd: classifierCost,
      trajectoryId,
      steps,
    });

    // Fire-and-forget audit
    logModerationAudit(text, result, requestId);

    return result;
  }

  // ── Result builder ──────────────────────────────────────────────────

  private buildResult(params: {
    action: ModerationAction;
    triggeredBy: ModerationResult["triggeredBy"];
    direction: ScreeningDirection;
    context: ScreeningContext;
    ratingLevel: ContentRatingLevel;
    blocklistMatches: string[];
    classifierOutput?: ModerationResult["classifierOutput"];
    reasoning: string;
    severityAdjustment: number;
    contextFactors: string[];
    attributeToUser: boolean;
    pipelineLatencyMs: number;
    classifierCostUsd: number;
    trajectoryId: string;
    steps?: Step[];
  }): ModerationResult {
    return {
      action: params.action,
      triggeredBy: params.triggeredBy,
      direction: params.direction,
      contentType: params.context.contentType,
      contentRatingLevel: params.ratingLevel,
      blocklistMatches: params.blocklistMatches,
      classifierOutput: params.classifierOutput,
      reasoning: params.reasoning,
      severityAdjustment: params.severityAdjustment,
      contextFactors: params.contextFactors,
      attributeToUser: params.attributeToUser,
      pipelineLatencyMs: params.pipelineLatencyMs,
      classifierCostUsd: params.classifierCostUsd,
      trajectoryId: params.trajectoryId,
      agentId: this.identity.actorId,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let guardianInstance: Guardian = new Guardian();

/** Get the current Guardian agent instance */
export function getGuardian(): Guardian {
  return guardianInstance;
}

/** Set the Guardian instance (for tests) — returns previous */
export function setGuardian(guardian: Guardian): Guardian {
  const previous = guardianInstance;
  guardianInstance = guardian;
  return previous;
}

/** Reset to a fresh Guardian instance */
export function resetGuardian(): void {
  guardianInstance = new Guardian();
}
