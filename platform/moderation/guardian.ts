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
import { withTrajectory } from "@/platform/agents/trajectory-closure";
import {
  getTrajectoryStore,
  type TrajectoryStore,
} from "@/platform/agents/trajectory-store";
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

/**
 * Whether a classifier output is a judgement the thresholds may act on (review 8 H-B): not
 * marked unjudged, a confidence in 0–1 and a known severity. Checked here as well as in the
 * parser, so no output — whatever produced it — reaches the thresholds on a placeholder.
 */
export function isJudgement(output: {
  readonly unjudged?: true;
  readonly confidence: unknown;
  readonly severity: unknown;
  readonly safe: unknown;
}): boolean {
  return (
    output.unjudged !== true &&
    typeof output.safe === "boolean" &&
    typeof output.confidence === "number" &&
    Number.isFinite(output.confidence) &&
    output.confidence >= 0 &&
    output.confidence <= 1 &&
    typeof output.severity === "string" &&
    Object.prototype.hasOwnProperty.call(SEVERITY_RANK, output.severity)
  );
}

/**
 * The result's fields when nothing was judged — an outage, or an answer that is not a judgement:
 * the content is withheld and not queued for review (review 8 M4: unjudged answers were queued,
 * and a user could fill the queue with them).
 */
function unjudgedFields(
  unavailable: boolean,
  unjudged: boolean
): Pick<ModerationResult, "screeningUnavailable" | "unjudgedReason"> {
  if (unavailable) return { screeningUnavailable: true, unjudgedReason: "unavailable" };
  if (unjudged) return { screeningUnavailable: true, unjudgedReason: "unreadable" };
  return {};
}

/**
 * Whether the classifier model declined to classify the text (stop_reason "refusal", TASK-186).
 * The owner's decision: withheld for human review at every rating level, before any threshold or
 * context reduction is read — never allowed, and no strike (escalate never runs the Sentinel; a
 * strike follows only if a reviewer decides it was a violation). Not an outage: it is queued.
 */
function isDeclined(output: object): boolean {
  return (output as { declined?: unknown }).declined === true;
}
/** A declined text's decision: escalated (withheld, queued for review), with its reason. */
function markDeclined(
  acc: { action: ModerationAction; triggeredBy: ModerationResult["triggeredBy"] },
  reasonParts: string[]
): void {
  acc.action = "escalate";
  acc.triggeredBy = "content-rating";
  reasonParts.push(
    "Classifier declined to assess the content (declined) — withheld for human review."
  );
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
   * The runtime trajectory of a screen with nothing to screen: opened for its id, and ended at
   * once (TASK-193 — it was left `running` for good).
   */
  private emptyRun(
    store: TrajectoryStore,
    direction: ScreeningDirection
  ): Promise<string> {
    return withTrajectory(
      {
        subject: { kind: "agent", id: this.identity.actorId },
        trigger: `guardian-${direction}`,
        scopeType: "platform",
        store,
      },
      async (id) => id
    );
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

    // ── Guard: empty text (a runtime trajectory for the id, ended at once: TASK-193) ──
    if (!text || text.trim().length === 0) {
      const emptyId = await this.emptyRun(trajectoryStore, direction);
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
        trajectoryId: emptyId,
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
      classifierCostUsd: number;
      classifierUnavailable: boolean;
      /** The classifier answered, but not a judgement (review 8 H-B, M4). */
      unjudged: boolean;
    } = {
      ctxEval: await evaluateContext(context),
      blocklistResult: scanBlocklist(text),
      action: "allow",
      triggeredBy: "none",
      severityAdjustment: 0,
      reasoning: "",
      classifierCostUsd: 0,
      classifierUnavailable: false,
      unjudged: false,
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
          const classified = await classify(text, requestId);
          acc.classifierOutput = classified;
          // What the call cost (D-20: recorded as 0), and whether it judged anything (RR-8).
          acc.classifierCostUsd = Number.isFinite(classified.costUsd)
            ? classified.costUsd
            : 0;
          acc.classifierUnavailable = classified.unavailable === true;
          return {
            action: "classify-content",
            boundary: "cognition",
            input: { textLength: text.length },
            output: {
              safe: classified.safe,
              categories: classified.categories,
              confidence: classified.confidence,
              severity: classified.severity,
              ...(acc.classifierUnavailable ? { unavailable: true } : {}),
            },
            costUsd: acc.classifierCostUsd,
            continueExecution: true,
          };
        }
        case 3: {
          const classifierOutput = acc.classifierOutput!;
          acc.severityAdjustment =
            acc.ctxEval.severityReduction > 0 ? -acc.ctxEval.severityReduction : 0;

          if (acc.classifierUnavailable || !isJudgement(classifierOutput)) {
            acc.unjudged = !acc.classifierUnavailable;
            // Nothing was judged (an outage, or an answer that could not be read): the text is
            // withheld at every rating level, whatever the thresholds (review 7 H1). Before: the
            // placeholder confidence 0.5 / severity medium went through the level's thresholds,
            // and level 3's (escalate below 0.5, warn at high) allowed it.
            acc.action = "escalate";
            acc.triggeredBy = "content-rating";
            reasonParts.push(
              acc.classifierUnavailable
                ? "Classifier unavailable — content withheld at every rating level (fail-closed)."
                : "Classifier answer unreadable — withheld for human review at every rating level (fail-closed)."
            );
          } else if (isDeclined(classifierOutput)) {
            markDeclined(acc, reasonParts);
          } else if (classifierOutput.safe) {
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
        classifierCostUsd: acc.classifierCostUsd,
        trajectoryId: exec.trajectoryId,
        screeningUnavailable: true,
        unjudgedReason: "unavailable",
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
      classifierCostUsd: acc.classifierCostUsd,
      trajectoryId: exec.trajectoryId,
      // Nothing judged: withheld, and not queued for review (review 8 M4).
      ...unjudgedFields(acc.classifierUnavailable, acc.unjudged),
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
    screeningUnavailable?: boolean;
    unjudgedReason?: ModerationResult["unjudgedReason"];
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
      ...(params.screeningUnavailable ? { screeningUnavailable: true } : {}),
      ...(params.unjudgedReason ? { unjudgedReason: params.unjudgedReason } : {}),
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
