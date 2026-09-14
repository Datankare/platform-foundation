/**
 * platform/input/conductor.ts — Input orchestration
 *
 * The Conductor is the top-level orchestrator for the input agent layer.
 * It receives raw InputEvents, delegates to the classifier and intent
 * resolver, and emits ConductorOutput (including a full Trajectory) for
 * the UI to render.
 *
 * This is the only module the UI needs to interact with — the classifier
 * and intent resolver are internal implementation details.
 *
 * GenAI Principles:
 *   P1  — Single entry point for all input processing
 *   P2  — Multi-step orchestration: event → classify → resolve → emit
 *   P3  — requestId threaded through all steps for tracing
 *   P7  — Classifier and resolver are swappable via constructor
 *   P10 — forceMode() allows user to override detected classification
 *   P11 — If classification fails, falls back to text mode
 *   P15 — Conductor has its own agent identity
 *   P17 — classify = cognition, route-to-pipeline = commitment
 *   P18 — Each input operation creates a Trajectory with Step records
 *
 * @module platform/input
 */

import type { AgentIdentity, Trajectory } from "@/platform/agents/types";
import type {
  InputEvent,
  InputMode,
  ConductorOutput,
  ClassificationResult,
  IntentResult,
} from "./types";
import { type InputClassifier, RuleBasedClassifier } from "./classifier";
import { type IntentResolver, type IntentContext, DefaultIntentResolver } from "./intent";
import { generateId } from "@/platform/agents/utils";
import { executeAgent } from "@/platform/agents/runtime";
import type { WorkflowFn } from "@/platform/agents/runtime";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";

// ── Trajectory helpers ────────────────────────────────────────────────

// Uses the shared crypto-secure helper (A5: no duplicate ID generators).
// See platform/agents/utils.ts.

// ── Interface ─────────────────────────────────────────────────────────

/**
 * Orchestrates the input agent layer.
 *
 * The Conductor is the boundary between raw user input and structured
 * agent output. It manages the classify → resolve → emit pipeline.
 */
export interface InputConductor {
  /** Agent identity for this conductor (P15) */
  readonly identity: AgentIdentity;

  /**
   * Process a raw input event through the classify → resolve pipeline.
   *
   * Returns a complete ConductorOutput that the UI can render,
   * including a Trajectory recording all steps (P18).
   */
  processEvent(event: InputEvent, context: IntentContext): Promise<ConductorOutput>;

  /**
   * Force a specific input mode (P10 — human override).
   *
   * When the user clicks a mode pill, this bypasses classification
   * and directly sets the mode. The intent resolver still runs
   * to determine available actions for the forced mode.
   */
  forceMode(mode: InputMode, context: IntentContext): Promise<ConductorOutput>;

  /**
   * Get the current state without processing a new event.
   */
  getCurrentOutput(): ConductorOutput;
}

// ── Default Implementation ────────────────────────────────────────────

/**
 * Default InputConductor with rule-based classifier and resolver.
 *
 * Both the classifier and resolver can be swapped via constructor
 * injection — this is how Sprint 4b will upgrade to agent-backed
 * implementations without changing the UI.
 *
 * Every processEvent/forceMode call produces a Trajectory (P18)
 * with Step records for each stage of the pipeline.
 */
export class DefaultInputConductor implements InputConductor {
  readonly identity: AgentIdentity;

  private classifier: InputClassifier;
  private resolver: IntentResolver;
  private currentClassification: ClassificationResult | null = null;
  private currentIntent: IntentResult | null = null;
  private currentMode: InputMode = "text";
  private modeForced = false;
  private currentTrajectory: Trajectory;

  constructor(classifier?: InputClassifier, resolver?: IntentResolver, actorId?: string) {
    this.classifier = classifier ?? new RuleBasedClassifier();
    this.resolver = resolver ?? new DefaultIntentResolver();
    const agentId = actorId ?? "conductor-default";
    this.identity = {
      actorType: "agent",
      actorId: agentId,
      agentRole: "conductor",
    };
    // Initial trajectory — no steps yet (the runtime owns per-call trajectories, ADR-039 F3b)
    const now = new Date().toISOString();
    this.currentTrajectory = {
      trajectoryId: `traj-${generateId()}`,
      agentId,
      steps: [],
      status: "completed",
      totalCost: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async processEvent(
    event: InputEvent,
    context: IntentContext
  ): Promise<ConductorOutput> {
    // ADR-039 F3b: the runtime owns the trajectory. processEvent runs its classify -> resolve
    // steps through executeAgent instead of a hand-rolled steps[] + traj- id.
    let classification: ClassificationResult = {
      classification: "text",
      confidence: 0,
      mode: "text",
      classifiedBy: "fallback",
      latencyMs: 0,
      cost: 0,
    };

    const workflow: WorkflowFn = async (ctx) => {
      if (ctx.stepCount === 0) {
        let fellBack = false;
        try {
          classification = await this.classifier.classify(event);
        } catch {
          classification = {
            classification: "text",
            confidence: 0,
            mode: "text",
            classifiedBy: "fallback",
            latencyMs: 0,
            cost: 0,
          };
          fellBack = true;
        }
        this.currentClassification = classification;
        this.currentMode = classification.mode;
        this.modeForced = false;
        return {
          action: "classify",
          boundary: "cognition",
          input: { eventType: event.type },
          output: fellBack
            ? { classification: "text", confidence: 0, fallback: true }
            : {
                classification: classification.classification,
                confidence: classification.confidence,
                mode: classification.mode,
              },
          costUsd: classification.cost,
          continueExecution: true,
        };
      }

      const intentContext: IntentContext = { ...context, currentMode: this.currentMode };
      let resolveFellBack = false;
      try {
        this.currentIntent = await this.resolver.resolve(classification, intentContext);
      } catch {
        this.currentIntent = {
          intent: "unknown",
          displayLabel: "Processing...",
          confidence: 0,
          actions: [],
          resolvedBy: "fallback",
          latencyMs: 0,
          cost: 0,
        };
        resolveFellBack = true;
      }
      return {
        action: "resolve-intent",
        boundary: "cognition",
        input: { classification: classification.classification, mode: this.currentMode },
        output: resolveFellBack
          ? { intent: "unknown", fallback: true }
          : {
              intent: this.currentIntent.intent,
              confidence: this.currentIntent.confidence,
              actionCount: this.currentIntent.actions.length,
            },
        costUsd: this.currentIntent.cost,
        continueExecution: false,
      };
    };

    const exec = await executeAgent(
      "conductor",
      "input-event",
      "user",
      this.identity.actorId,
      workflow
    );
    const rec = await getTrajectoryStore().getById(exec.trajectoryId);
    if (rec) this.currentTrajectory = rec.trajectory;

    return this.getCurrentOutput();
  }

  async forceMode(mode: InputMode, context: IntentContext): Promise<ConductorOutput> {
    this.currentMode = mode;
    this.modeForced = true;
    const classification: ClassificationResult = {
      classification:
        mode === "speech"
          ? "speech"
          : mode === "music"
            ? "music"
            : mode === "file"
              ? "file"
              : "text",
      confidence: 1.0,
      mode,
      classifiedBy: "user-forced",
      latencyMs: 0,
      cost: 0,
    };
    this.currentClassification = classification;

    const workflow: WorkflowFn = async (ctx) => {
      if (ctx.stepCount === 0) {
        return {
          action: "force-mode",
          boundary: "cognition",
          input: { forcedMode: mode },
          output: {
            classification: classification.classification,
            confidence: 1.0,
            userForced: true,
          },
          costUsd: 0,
          continueExecution: true,
        };
      }
      const intentContext: IntentContext = { ...context, currentMode: mode };
      let resolveFellBack = false;
      try {
        this.currentIntent = await this.resolver.resolve(classification, intentContext);
      } catch {
        this.currentIntent = {
          intent: "unknown",
          displayLabel: "Processing...",
          confidence: 0,
          actions: [],
          resolvedBy: "fallback",
          latencyMs: 0,
          cost: 0,
        };
        resolveFellBack = true;
      }
      return {
        action: "resolve-intent",
        boundary: "cognition",
        input: { classification: classification.classification, mode },
        output: resolveFellBack
          ? { intent: "unknown", fallback: true }
          : {
              intent: this.currentIntent.intent,
              confidence: this.currentIntent.confidence,
              actionCount: this.currentIntent.actions.length,
            },
        costUsd: this.currentIntent.cost,
        continueExecution: false,
      };
    };

    const exec = await executeAgent(
      "conductor",
      "force-mode",
      "user",
      this.identity.actorId,
      workflow
    );
    const rec = await getTrajectoryStore().getById(exec.trajectoryId);
    if (rec) this.currentTrajectory = rec.trajectory;

    return this.getCurrentOutput();
  }

  getCurrentOutput(): ConductorOutput {
    return {
      mode: this.currentMode,
      classification: this.currentClassification,
      intent: this.currentIntent,
      modeForced: this.modeForced,
      classifying: false,
      trajectory: this.currentTrajectory,
    };
  }
}
