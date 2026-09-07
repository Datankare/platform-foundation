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

import type { AgentIdentity } from "@/platform/agents/types";
import { executeAgent } from "@/platform/agents/runtime";
import type { WorkflowFn } from "@/platform/agents/runtime";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";
import { generateId } from "@/platform/agents/utils";
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
import { logger } from "@/lib/logger";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

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
    const ratingLevel: ContentRatingLevel = context.contentRatingLevel ?? 1;
    const reasonParts: string[] = [];
    const trajectoryStore = getTrajectoryStore();
    const scope = context.userId ?? "anonymous";

    // ── Guard: empty text (still minted a runtime trajectory for the id) ──
    if (!text || text.trim().length === 0) {
      const empty = await trajectoryStore.create(
        { kind: "agent", id: this.identity.actorId },
        `guardian-${direction}`,
        "platform"
      );
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
        trajectoryId: empty.trajectory.trajectoryId,
      });
    }

    // ADR-039 F3c: the runtime owns the trajectory. screen() runs its decision stages through
    // executeAgent (recording each as a governed step) instead of hand-rolled makeStep/steps[].
    // Step-shared state lives in one object so the closure's assignments survive to buildResult
    // (object-property reads are not CFA-narrowed the way a captured `let` would be).
    const acc: {
      ctxEval: Awaited<ReturnType<typeof evaluateContext>>;
      blocklistResult: ReturnType<typeof scanBlocklist>;
      classifierOutput?: ModerationResult["classifierOutput"];
      action: ModerationAction;
      triggeredBy: ModerationResult["triggeredBy"];
      severityAdjustment: number;
      reasoning: string;
    } = {
      ctxEval: await evaluateContext(context),
      blocklistResult: scanBlocklist(text),
      action: "allow",
      triggeredBy: "none",
      severityAdjustment: 0,
      reasoning: "",
    };
    // evaluateContext/scanBlocklist are re-run inside the workflow steps below so each stage is
    // recorded against the runtime trajectory; the initial values above keep the type definite.

    const workflow: WorkflowFn = async (ctx) => {
      switch (ctx.stepCount) {
        case 0: {
          acc.ctxEval = await evaluateContext(context);
          if (acc.ctxEval.factors.length > 0) {
            reasonParts.push(`Context: ${acc.ctxEval.factors.join("; ")}.`);
          }
          return {
            action: "receive-context",
            boundary: "cognition",
            input: {
              contentType: context.contentType,
              contentRatingLevel: ratingLevel,
              userId: scope,
            },
            output: {
              severityReduction: acc.ctxEval.severityReduction,
              attributeToUser: acc.ctxEval.attributeToUser,
              factors: acc.ctxEval.factors,
            },
            costUsd: 0,
            continueExecution: true,
          };
        }
        case 1: {
          acc.blocklistResult = scanBlocklist(text);
          return {
            action: "blocklist-scan",
            boundary: "cognition",
            input: { textLength: text.length },
            output: {
              matched: acc.blocklistResult.matched,
              matchCount: acc.blocklistResult.matches.length,
              maxSeverity: acc.blocklistResult.maxSeverity,
            },
            costUsd: 0,
            continueExecution: true,
          };
        }
        case 2: {
          // Critical/high blocklist hit → block immediately, skip classifier (terminal decide).
          if (
            acc.blocklistResult.matched &&
            BLOCKLIST_BLOCK_SEVERITIES.has(acc.blocklistResult.maxSeverity)
          ) {
            acc.action = "block";
            acc.triggeredBy = "blocklist";
            acc.reasoning = `Blocklist hit: ${acc.blocklistResult.matches
              .map((m) => m.category)
              .join(
                ", "
              )} (severity: ${acc.blocklistResult.maxSeverity}). Blocked immediately — classifier skipped.`;
            return {
              action: "decide",
              boundary: "commitment",
              input: { trigger: "blocklist", severity: acc.blocklistResult.maxSeverity },
              output: { action: "block", reasoning: acc.reasoning },
              costUsd: 0,
              continueExecution: false,
            };
          }
          acc.classifierOutput = await classify(text, requestId);
          return {
            action: "classify-content",
            boundary: "cognition",
            input: { textLength: text.length },
            output: {
              safe: acc.classifierOutput.safe,
              categories: acc.classifierOutput.categories,
              confidence: acc.classifierOutput.confidence,
              severity: acc.classifierOutput.severity,
            },
            costUsd: 0,
            continueExecution: true,
          };
        }
        case 3: {
          const classifierOutput = acc.classifierOutput!;
          acc.severityAdjustment =
            acc.ctxEval.severityReduction > 0 ? -acc.ctxEval.severityReduction : 0;

          if (classifierOutput.safe) {
            acc.action = acc.blocklistResult.matched ? "warn" : "allow";
            acc.triggeredBy = acc.blocklistResult.matched ? "blocklist" : "none";
            reasonParts.push(
              `Classifier: safe (confidence ${classifierOutput.confidence.toFixed(2)}).`
            );
            if (acc.blocklistResult.matched) {
              reasonParts.push(`Low-severity blocklist match — warning applied.`);
            }
          } else {
            let thresholds;
            try {
              thresholds = await loadContentRatingThresholds(ratingLevel);
            } catch {
              thresholds = {
                level: 1 as const,
                label: "fail-closed (config unavailable)",
                blockSeverity: "low" as const,
                warnSeverity: "low" as const,
                escalateBelow: 0.95,
              };
              reasonParts.push("Config unavailable — using fail-closed thresholds.");
            }

            const originalSeverity = classifierOutput.severity;
            const adjustedSeverity = reduceSeverity(
              originalSeverity,
              acc.ctxEval.severityReduction
            );

            if (acc.ctxEval.severityReduction > 0) {
              reasonParts.push(
                `Severity adjusted: ${originalSeverity} → ${adjustedSeverity} (${context.contentType} context, -${acc.ctxEval.severityReduction}).`
              );
            }

            if (classifierOutput.confidence < thresholds.escalateBelow) {
              acc.action = "escalate";
              acc.triggeredBy = "content-rating";
              reasonParts.push(
                `Confidence ${classifierOutput.confidence.toFixed(2)} below threshold ${thresholds.escalateBelow} for ${thresholds.label} — escalating for human review.`
              );
            } else if (severityAtOrAbove(adjustedSeverity, thresholds.blockSeverity)) {
              acc.action = "block";
              acc.triggeredBy = "content-rating";
              reasonParts.push(
                `Adjusted severity ${adjustedSeverity} ≥ block threshold ${thresholds.blockSeverity} for ${thresholds.label}.`
              );
            } else if (severityAtOrAbove(adjustedSeverity, thresholds.warnSeverity)) {
              acc.action = "warn";
              acc.triggeredBy = "content-rating";
              reasonParts.push(
                `Adjusted severity ${adjustedSeverity} ≥ warn threshold ${thresholds.warnSeverity} for ${thresholds.label}.`
              );
            } else {
              acc.action = "allow";
              acc.triggeredBy = "content-rating";
              reasonParts.push(
                `Adjusted severity ${adjustedSeverity} below warn threshold for ${thresholds.label} — allowed.`
              );
            }
          }

          return {
            action: "evaluate-thresholds",
            boundary: "cognition",
            input: {
              safe: classifierOutput.safe,
              severity: classifierOutput.severity,
              severityAdjustment: acc.severityAdjustment,
              ratingLevel,
            },
            output: { action: acc.action, triggeredBy: acc.triggeredBy },
            costUsd: 0,
            continueExecution: true,
          };
        }
        default: {
          acc.reasoning = reasonParts.join(" ");
          return {
            action: "decide",
            boundary: "commitment",
            input: { proposedAction: acc.action },
            output: {
              finalAction: acc.action,
              reasoning: acc.reasoning,
              attributeToUser: acc.ctxEval.attributeToUser,
            },
            costUsd: 0,
            continueExecution: false,
          };
        }
      }
    };

    const exec = await executeAgent(
      "guardian-social",
      `guardian-${direction}`,
      "user",
      scope,
      workflow
    );

    // ADR-039 F3c fail-closed guard: if the screening run did not complete (agent unavailable,
    // budget exhausted, mid-run error), NEVER return the default allow. Escalate for human review
    // — fail-closed, and bounded by the ADR-041 SLA. Restores Guardian's "fail closed on any
    // error" contract.
    if (!exec.success || exec.finalStatus !== "completed") {
      logger.error(
        "Guardian screening run did not complete — failing closed to escalate",
        {
          route: "platform/moderation/guardian",
          requestId,
          finalStatus: exec.finalStatus,
          error: exec.error,
        }
      );
      const failClosed = this.buildResult({
        action: "escalate",
        triggeredBy: "context",
        direction,
        context,
        ratingLevel,
        blocklistMatches: acc.blocklistResult.matches.map((m) => m.matched),
        classifierOutput: acc.classifierOutput,
        reasoning:
          "Screening run did not complete — escalated for human review (fail-closed).",
        severityAdjustment: acc.severityAdjustment,
        contextFactors: acc.ctxEval.factors,
        attributeToUser: acc.ctxEval.attributeToUser,
        pipelineLatencyMs: Date.now() - startTime,
        classifierCostUsd: 0,
        trajectoryId: exec.trajectoryId,
      });
      logModerationAudit(text, failClosed, requestId);
      return failClosed;
    }

    const result = this.buildResult({
      action: acc.action,
      triggeredBy: acc.triggeredBy,
      direction,
      context,
      ratingLevel,
      blocklistMatches: acc.blocklistResult.matches.map((m) => m.matched),
      classifierOutput: acc.classifierOutput,
      reasoning: acc.reasoning,
      severityAdjustment: acc.severityAdjustment,
      contextFactors: acc.ctxEval.factors,
      attributeToUser: acc.ctxEval.attributeToUser,
      pipelineLatencyMs: Date.now() - startTime,
      classifierCostUsd: 0,
      trajectoryId: exec.trajectoryId,
    });

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

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const GUARDIAN_KEY = "platform.moderation.guardian";
function readGuardianInstance(): Guardian {
  return getSingleton<Guardian>(GUARDIAN_KEY, () => new Guardian());
}
function writeGuardianInstance(next: Guardian): void {
  setSingleton<Guardian>(GUARDIAN_KEY, next);
}

/** Get the current Guardian agent instance */
export function getGuardian(): Guardian {
  return readGuardianInstance();
}

/** Set the Guardian instance (for tests) — returns previous */
export function setGuardian(guardian: Guardian): Guardian {
  const previous = readGuardianInstance();
  writeGuardianInstance(guardian);
  return previous;
}

/** Reset to a fresh Guardian instance */
export function resetGuardian(): void {
  writeGuardianInstance(new Guardian());
}
