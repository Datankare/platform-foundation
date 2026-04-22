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

import type {
  AgentIdentity,
  Trajectory,
  Step,
  StepBoundary,
} from "@/platform/agents/types";
import type {
  InputEvent,
  InputMode,
  ConductorOutput,
  ClassificationResult,
  IntentResult,
} from "./types";
import { type InputClassifier, RuleBasedClassifier } from "./classifier";
import { type IntentResolver, type IntentContext, DefaultIntentResolver } from "./intent";

// ── Trajectory helpers ────────────────────────────────────────────────

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

function buildTrajectory(
  agentId: string,
  steps: Step[],
  status: Trajectory["status"] = "completed"
): Trajectory {
  const now = new Date().toISOString();
  return {
    trajectoryId: `traj-${generateId()}`,
    agentId,
    steps,
    status,
    totalCost: steps.reduce((sum, s) => sum + s.cost, 0),
    createdAt: now,
    updatedAt: now,
  };
}

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
    // Initial trajectory — no steps yet
    this.currentTrajectory = buildTrajectory(agentId, []);
  }

  async processEvent(
    event: InputEvent,
    context: IntentContext
  ): Promise<ConductorOutput> {
    const steps: Step[] = [];

    // Step 0: Classify the input (P17 — cognition)
    let classification: ClassificationResult;
    const classifyStart = Date.now();
    try {
      classification = await this.classifier.classify(event);
      steps.push(
        makeStep(
          0,
          "classify",
          "cognition",
          { eventType: event.type },
          {
            classification: classification.classification,
            confidence: classification.confidence,
            mode: classification.mode,
          },
          Date.now() - classifyStart,
          classification.cost
        )
      );
    } catch {
      // P11: classification failure → fallback to text mode
      classification = {
        classification: "text",
        confidence: 0,
        mode: "text",
        classifiedBy: "fallback",
        latencyMs: 0,
        cost: 0,
      };
      steps.push(
        makeStep(
          0,
          "classify",
          "cognition",
          { eventType: event.type },
          { classification: "text", confidence: 0, fallback: true },
          Date.now() - classifyStart,
          0
        )
      );
    }

    this.currentClassification = classification;
    this.currentMode = classification.mode;
    this.modeForced = false;

    // Step 1: Resolve intent (P17 — cognition)
    const intentContext: IntentContext = {
      ...context,
      currentMode: this.currentMode,
    };

    let intent: IntentResult;
    const resolveStart = Date.now();
    try {
      intent = await this.resolver.resolve(classification, intentContext);
      steps.push(
        makeStep(
          1,
          "resolve-intent",
          "cognition",
          { classification: classification.classification, mode: this.currentMode },
          {
            intent: intent.intent,
            confidence: intent.confidence,
            actionCount: intent.actions.length,
          },
          Date.now() - resolveStart,
          intent.cost
        )
      );
    } catch {
      // P11: resolution failure → generic fallback
      intent = {
        intent: "unknown",
        displayLabel: "Processing...",
        confidence: 0,
        actions: [],
        resolvedBy: "fallback",
        latencyMs: 0,
        cost: 0,
      };
      steps.push(
        makeStep(
          1,
          "resolve-intent",
          "cognition",
          { classification: classification.classification, mode: this.currentMode },
          { intent: "unknown", fallback: true },
          Date.now() - resolveStart,
          0
        )
      );
    }

    this.currentIntent = intent;
    this.currentTrajectory = buildTrajectory(this.identity.actorId, steps);

    return this.getCurrentOutput();
  }

  async forceMode(mode: InputMode, context: IntentContext): Promise<ConductorOutput> {
    const steps: Step[] = [];
    this.currentMode = mode;
    this.modeForced = true;

    // Step 0: Synthetic classification for forced mode (P17 — cognition)
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

    steps.push(
      makeStep(
        0,
        "force-mode",
        "cognition",
        { forcedMode: mode },
        {
          classification: classification.classification,
          confidence: 1.0,
          userForced: true,
        },
        0,
        0
      )
    );

    // Step 1: Resolve intent for the forced mode
    const intentContext: IntentContext = {
      ...context,
      currentMode: mode,
    };

    const resolveStart = Date.now();
    try {
      this.currentIntent = await this.resolver.resolve(classification, intentContext);
      steps.push(
        makeStep(
          1,
          "resolve-intent",
          "cognition",
          { classification: classification.classification, mode },
          {
            intent: this.currentIntent.intent,
            confidence: this.currentIntent.confidence,
            actionCount: this.currentIntent.actions.length,
          },
          Date.now() - resolveStart,
          this.currentIntent.cost
        )
      );
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
      steps.push(
        makeStep(
          1,
          "resolve-intent",
          "cognition",
          { classification: classification.classification, mode },
          { intent: "unknown", fallback: true },
          Date.now() - resolveStart,
          0
        )
      );
    }

    this.currentTrajectory = buildTrajectory(this.identity.actorId, steps);

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
