/**
 * platform/input/intent.ts — Intent resolution
 *
 * Interface for mapping classified input to user intent and available actions.
 * The default implementation maps deterministically from classification to
 * standard action sets. Consumers (Playform) provide their own IntentResolver
 * with domain-specific intent mappings and action sets.
 *
 * GenAI Principles:
 *   P1  — Intent is a structured execution plan
 *   P6  — IntentResult + ActionItem[] are typed schemas
 *   P7  — Interface allows rule-based or agent-backed implementation
 *   P8  — Resolver receives context (current mode, language, etc.)
 *   P11 — Fallback to generic actions if resolution fails
 *   P15 — resolvedBy identifies which resolver ran
 *   P17 — Intent resolution is cognition; action execution is commitment
 *
 * @module platform/input
 */

import type { ClassificationResult, IntentResult, ActionItem, InputMode } from "./types";

// ── Context ───────────────────────────────────────────────────────────

/**
 * Context provided to the IntentResolver for stateful resolution.
 *
 * This allows the resolver to consider what the user is currently doing,
 * what language they're working in, and other contextual signals.
 */
export interface IntentContext {
  /** Current input mode (detected or forced) */
  readonly currentMode: InputMode;
  /** Source language code (e.g., "en", "auto") */
  readonly sourceLanguage?: string;
  /** Target language code (e.g., "es") */
  readonly targetLanguage?: string;
  /** Whether the user has active text in the input area */
  readonly hasText: boolean;
  /** Whether audio recording is currently active */
  readonly isRecording: boolean;
  /** Optional: additional domain-specific context */
  readonly extra?: Record<string, unknown>;
}

// ── Interface ─────────────────────────────────────────────────────────

/**
 * Resolves classified input into user intent and available actions.
 *
 * Implementations:
 * - DefaultIntentResolver (Sprint 1a): generic action sets
 * - PlayformIntentResolver (Sprint 1b): translation/identification actions
 * - AgentIntentResolver (Sprint 4b): LLM-backed intent resolution
 */
export interface IntentResolver {
  /** Resolver name for observability (P15) */
  readonly name: string;

  /**
   * Resolve classified input to intent and actions.
   *
   * Intent resolution is COGNITION (P17) — advisory, not committed.
   * The user can choose any action from the returned ActionItem[],
   * including ones that don't match the detected intent.
   */
  resolve(
    classification: ClassificationResult,
    context: IntentContext
  ): Promise<IntentResult>;
}

// ── Default Implementation ────────────────────────────────────────────

/** Standard action: process the input */
const ACTION_PROCESS: ActionItem = {
  id: "process",
  label: "Process",
  primary: true,
};

/** Standard action: clear the input */
const ACTION_CLEAR: ActionItem = {
  id: "clear",
  label: "Clear",
  primary: false,
};

/**
 * Default intent resolver with generic action sets.
 *
 * Maps classifications to generic intents:
 * - text → "process_text" with Process + Clear
 * - speech → "transcribe" with Process + Clear
 * - music → "identify" with Process + Clear
 * - file → "extract" with Process + Clear
 *
 * Consumers (Playform) replace this with domain-specific mappings
 * (e.g., text → "translate", music → "identify_song").
 */
export class DefaultIntentResolver implements IntentResolver {
  readonly name = "default";

  async resolve(
    classification: ClassificationResult,
    _context: IntentContext
  ): Promise<IntentResult> {
    const start = Date.now();

    let intent: string;
    let displayLabel: string;
    let actions: ActionItem[];

    switch (classification.mode) {
      case "text":
        intent = "process_text";
        displayLabel = "Process text";
        actions = [ACTION_PROCESS, ACTION_CLEAR];
        break;
      case "speech":
        intent = "transcribe";
        displayLabel = "Transcribe speech";
        actions = [ACTION_PROCESS, ACTION_CLEAR];
        break;
      case "music":
        intent = "identify";
        displayLabel = "Identify audio";
        actions = [ACTION_PROCESS, ACTION_CLEAR];
        break;
      case "file":
        intent = "extract";
        displayLabel = "Extract content";
        actions = [ACTION_PROCESS, ACTION_CLEAR];
        break;
    }

    const latencyMs = Date.now() - start;

    return {
      intent,
      displayLabel,
      confidence: classification.confidence,
      actions,
      resolvedBy: this.name,
      latencyMs,
      cost: 0,
    };
  }
}
