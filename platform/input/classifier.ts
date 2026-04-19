/**
 * platform/input/classifier.ts — Input classification
 *
 * Interface for classifying raw input into content categories.
 * The default implementation is rule-based (deterministic).
 * Sprint 4b swaps in an agent-backed implementation for audio
 * classification (the critical AI decision: speech vs music vs noise).
 *
 * GenAI Principles:
 *   P6  — Structured ClassificationResult output
 *   P7  — Interface allows rule-based or agent-backed implementation
 *   P11 — Rule-based default IS the fallback when agent is unavailable
 *   P15 — classifiedBy identifies which classifier ran
 *   P17 — Classification is cognition (internal, revisable)
 *
 * @module platform/input
 */

import type {
  InputEvent,
  ClassificationResult,
  ContentClassification,
  InputMode,
} from "./types";

// ── Interface ─────────────────────────────────────────────────────────

/**
 * Classifies raw input events into content categories.
 *
 * Implementations:
 * - RuleBasedClassifier (Sprint 1a): deterministic, zero-cost
 * - AgentClassifier (Sprint 4b): LLM-backed audio analysis
 */
export interface InputClassifier {
  /** Classifier name for observability (P15) */
  readonly name: string;

  /**
   * Classify an input event.
   *
   * Returns a structured ClassificationResult with confidence score.
   * Classification is COGNITION (P17) — internal and revisable.
   * The caller (Conductor) decides whether to commit to the classification.
   */
  classify(event: InputEvent): Promise<ClassificationResult>;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Map a content classification to its corresponding input mode.
 *
 * noise → "text" (fallback — P11 resilient degradation)
 */
export function classificationToMode(classification: ContentClassification): InputMode {
  switch (classification) {
    case "speech":
      return "speech";
    case "music":
      return "music";
    case "noise":
      return "text"; // P11: noise falls back to text mode
    case "text":
      return "text";
    case "file":
      return "file";
  }
}

// ── Default Implementation ────────────────────────────────────────────

/**
 * Rule-based input classifier.
 *
 * Deterministic classification based on event type:
 * - keystroke/paste → text
 * - file → file
 * - mic → speech (rule-based cannot distinguish speech from music;
 *   that's the agent's job in Sprint 4b)
 *
 * Cost: $0 (no AI calls). Confidence: 1.0 for deterministic decisions,
 * 0.5 for mic (because we can't tell speech from music without AI).
 */
export class RuleBasedClassifier implements InputClassifier {
  readonly name = "rule-based";

  async classify(event: InputEvent): Promise<ClassificationResult> {
    const start = Date.now();

    let classification: ContentClassification;
    let confidence: number;

    switch (event.type) {
      case "keystroke":
      case "paste":
        classification = "text";
        confidence = 1.0;
        break;
      case "file":
        classification = "file";
        confidence = 1.0;
        break;
      case "mic":
        // Rule-based cannot distinguish speech from music.
        // Default to speech. Agent-backed classifier in Sprint 4b
        // will analyze audio features to make this decision.
        classification = "speech";
        confidence = 0.5;
        break;
    }

    const mode = classificationToMode(classification);
    const latencyMs = Date.now() - start;

    return {
      classification,
      confidence,
      mode,
      classifiedBy: this.name,
      latencyMs,
      cost: 0,
    };
  }
}
