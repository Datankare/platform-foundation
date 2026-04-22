/**
 * platform/input/types.ts — Input agent type contracts
 *
 * Defines the typed vocabulary for the input agent layer:
 * - InputEvent: what the user did (keystroke, mic, file, paste)
 * - InputMode: detected modality (text, speech, music, file)
 * - ClassificationResult: what the classifier determined
 * - IntentResult: what the user wants to do
 * - ActionItem: available actions rendered by the UI
 * - ConductorOutput: full output including Trajectory (P18)
 *
 * These types form the contract between the agent layer and the UI.
 * The UI renders whatever the agent layer returns — no hardcoded behavior.
 *
 * GenAI Principles:
 *   P1  — All input processing through typed interfaces
 *   P2  — Multi-step: event → classify → resolve intent → emit actions
 *   P3  — requestId + latencyMs on all results for observability
 *   P6  — All outputs are typed schemas, not free text
 *   P7  — Interfaces allow rule-based or agent-backed implementations
 *   P10 — InputMode can be forced by user (override classification)
 *   P11 — Fallback: if classification fails, default to "text" mode
 *   P12 — Cost tracking: cost field on results (0 for rule-based)
 *   P15 — classifiedBy tracks which classifier produced the result
 *   P17 — Classification = cognition; routing = commitment
 *   P18 — Every processEvent/forceMode produces a Trajectory
 *
 * @module platform/input
 */

import type { Trajectory } from "@/platform/agents/types";

// ── Input Events ──────────────────────────────────────────────────────

/**
 * The type of raw input event from the user.
 */
export type InputEventType = "keystroke" | "mic" | "file" | "paste";

/**
 * A raw input event from the user.
 *
 * The conductor receives these and delegates to the appropriate classifier.
 * Events are ephemeral — they are not stored or logged (privacy by design).
 */
export interface InputEvent {
  /** What kind of input event */
  readonly type: InputEventType;
  /** Text content (for keystroke/paste events) */
  readonly text?: string;
  /** Audio data (for mic events — raw browser MediaRecorder chunks) */
  readonly audioData?: ArrayBuffer;
  /** File reference (for file drop/upload events) */
  readonly file?: File;
  /** ISO timestamp of the event */
  readonly timestamp: string;
  /** Request ID for tracing (P3) */
  readonly requestId?: string;
}

// ── Input Modes ───────────────────────────────────────────────────────

/**
 * The detected or forced input modality.
 *
 * Modes are primarily DETECTED by the classifier, but can be FORCED
 * by the user clicking a mode pill (P10 — human override).
 */
export type InputMode = "text" | "speech" | "music" | "file";

// ── Classification ────────────────────────────────────────────────────

/**
 * Audio classification categories.
 *
 * The critical AI decision: is the mic input speech, music, or noise?
 * This determines the entire downstream processing pipeline.
 */
export type AudioClassification = "speech" | "music" | "noise";

/**
 * Content classification categories (all modalities).
 */
export type ContentClassification = AudioClassification | "text" | "file";

/**
 * Features extracted during audio classification.
 *
 * These features explain WHY the classifier made its decision,
 * enabling behavioral forensics (P18) and debugging.
 */
export interface AudioFeatures {
  /** Regularity of rhythmic patterns (0-1, high = likely music) */
  readonly rhythmRegularity: number;
  /** Harmonic content ratio (0-1, high = likely music) */
  readonly harmonicContent: number;
  /** Speech cadence score (0-1, high = likely speech) */
  readonly speechCadence: number;
}

/**
 * Result of input classification.
 *
 * Produced by the InputClassifier. Consumed by the IntentResolver.
 * This is a COGNITION output (P17) — revisable, not yet committed.
 */
export interface ClassificationResult {
  /** What was classified */
  readonly classification: ContentClassification;
  /** Classifier confidence (0-1) */
  readonly confidence: number;
  /** The input mode this classification maps to */
  readonly mode: InputMode;
  /** Audio features (only present for audio classifications) */
  readonly features?: AudioFeatures;
  /** Which classifier produced this result (P15) */
  readonly classifiedBy: string;
  /** Classification latency in ms (P3) */
  readonly latencyMs: number;
  /** Cost in USD (0 for rule-based, real cost for LLM-backed) (P12) */
  readonly cost: number;
}

// ── Intent Resolution ─────────────────────────────────────────────────

/**
 * The resolved user intent.
 *
 * Intent is ADVISORY (P17 cognition) — it suggests what the user wants
 * to do, but the user can override by choosing a different action.
 */
export interface IntentResult {
  /** Machine-readable intent identifier */
  readonly intent: string;
  /** Human-readable description for the intent bar */
  readonly displayLabel: string;
  /** Intent confidence (0-1) */
  readonly confidence: number;
  /** Available actions for this intent */
  readonly actions: readonly ActionItem[];
  /** Which resolver produced this (P15) */
  readonly resolvedBy: string;
  /** Resolution latency in ms (P3) */
  readonly latencyMs: number;
  /** Cost in USD (P12) */
  readonly cost: number;
}

// ── Action Items ──────────────────────────────────────────────────────

/**
 * An action the user can take, rendered as a button by the UI.
 *
 * The UI renders ActionItem[] — no hardcoded buttons. This is the
 * contract between the agent layer and the adaptive UI (P6).
 */
export interface ActionItem {
  /** Unique action identifier (e.g., "translate", "identify", "spotify") */
  readonly id: string;
  /** Button label text */
  readonly label: string;
  /** Whether this is the primary (highlighted) action */
  readonly primary: boolean;
  /** Optional icon name (e.g., "play", "search", "upload") */
  readonly icon?: string;
  /** Whether this action is currently disabled */
  readonly disabled?: boolean;
}

// ── Conductor Output ──────────────────────────────────────────────────

/**
 * The complete output of the InputConductor for a given input event.
 *
 * This is what the AdaptiveInput component consumes to render its state.
 * The trajectory records the full agent execution path (P18).
 */
export interface ConductorOutput {
  /** Current input mode (detected or forced) */
  readonly mode: InputMode;
  /** Classification result (if classification has run) */
  readonly classification: ClassificationResult | null;
  /** Intent result (if intent has been resolved) */
  readonly intent: IntentResult | null;
  /** Whether the mode was forced by user (P10) vs detected */
  readonly modeForced: boolean;
  /** Whether classification is currently in progress */
  readonly classifying: boolean;
  /** Full agent trajectory for this operation (P18) */
  readonly trajectory: Trajectory;
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// (L17) Module-level gotchas:
//
// 1. InputEvent.audioData is ArrayBuffer (browser API), NOT Buffer (Node).
//    Tests that create audio data should use `new ArrayBuffer(n)`, not `Buffer.alloc(n)`.
//
// 2. ActionItem.primary — exactly ONE action should be primary per ActionItem[].
//    The UI highlights the primary action. If zero are primary, no button is highlighted.
//    If multiple are primary, behavior is undefined.
//
// 3. ClassificationResult.mode is derived from classification, NOT the other way around.
//    speech → "speech", music → "music", noise → "text" (fallback), text → "text", file → "file".
//
// 4. IntentResult.intent is a machine-readable string (e.g., "translate", "identify_song").
//    IntentResult.displayLabel is human-readable (e.g., "Translate text", "Identify song").
//    Never use intent for display or displayLabel for logic.
//
// 5. ConductorOutput.trajectory is always present. Before any events, it has 0 steps
//    and status "completed". After processEvent/forceMode, it records classify + resolve steps.
//    Consumers that don't need trajectory data can ignore it.
