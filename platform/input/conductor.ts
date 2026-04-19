/**
 * platform/input/conductor.ts — Input orchestration
 *
 * The Conductor is the top-level orchestrator for the input agent layer.
 * It receives raw InputEvents, delegates to the classifier and intent
 * resolver, and emits ConductorOutput for the UI to render.
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
 *   P18 — Each input session creates a trajectory
 *
 * @module platform/input
 */

import type { AgentIdentity } from "@/platform/agents/types";
import type {
  InputEvent,
  InputMode,
  ConductorOutput,
  ClassificationResult,
  IntentResult,
} from "./types";
import { type InputClassifier, RuleBasedClassifier } from "./classifier";
import { type IntentResolver, type IntentContext, DefaultIntentResolver } from "./intent";

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
   * Returns a complete ConductorOutput that the UI can render.
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
 */
export class DefaultInputConductor implements InputConductor {
  readonly identity: AgentIdentity;

  private classifier: InputClassifier;
  private resolver: IntentResolver;
  private currentClassification: ClassificationResult | null = null;
  private currentIntent: IntentResult | null = null;
  private currentMode: InputMode = "text";
  private modeForced = false;

  constructor(classifier?: InputClassifier, resolver?: IntentResolver, actorId?: string) {
    this.classifier = classifier ?? new RuleBasedClassifier();
    this.resolver = resolver ?? new DefaultIntentResolver();
    this.identity = {
      actorType: "agent",
      actorId: actorId ?? "conductor-default",
      agentRole: "conductor",
    };
  }

  async processEvent(
    event: InputEvent,
    context: IntentContext
  ): Promise<ConductorOutput> {
    // Step 1: Classify the input (P17 — cognition)
    let classification: ClassificationResult;
    try {
      classification = await this.classifier.classify(event);
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
    }

    this.currentClassification = classification;
    this.currentMode = classification.mode;
    this.modeForced = false;

    // Step 2: Resolve intent (P17 — cognition)
    const intentContext: IntentContext = {
      ...context,
      currentMode: this.currentMode,
    };

    let intent: IntentResult;
    try {
      intent = await this.resolver.resolve(classification, intentContext);
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
    }

    this.currentIntent = intent;

    return this.getCurrentOutput();
  }

  async forceMode(mode: InputMode, context: IntentContext): Promise<ConductorOutput> {
    this.currentMode = mode;
    this.modeForced = true;

    // Create a synthetic classification for the forced mode
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

    // Resolve intent for the forced mode
    const intentContext: IntentContext = {
      ...context,
      currentMode: mode,
    };

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
    }

    return this.getCurrentOutput();
  }

  getCurrentOutput(): ConductorOutput {
    return {
      mode: this.currentMode,
      classification: this.currentClassification,
      intent: this.currentIntent,
      modeForced: this.modeForced,
      classifying: false,
    };
  }
}
