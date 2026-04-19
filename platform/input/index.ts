/**
 * platform/input/index.ts — Public API
 *
 * Input agent abstractions for the adaptive input layer.
 * Sprint 1a: interfaces + rule-based defaults.
 * Sprint 4b: agent-backed implementations swapped in.
 *
 * @module platform/input
 */

// Types
export type {
  InputEvent,
  InputEventType,
  InputMode,
  AudioClassification,
  ContentClassification,
  AudioFeatures,
  ClassificationResult,
  IntentResult,
  ActionItem,
  ConductorOutput,
} from "./types";

// Classifier
export type { InputClassifier } from "./classifier";
export { RuleBasedClassifier, classificationToMode } from "./classifier";

// Intent resolver
export type { IntentResolver, IntentContext } from "./intent";
export { DefaultIntentResolver } from "./intent";

// Conductor
export type { InputConductor } from "./conductor";
export { DefaultInputConductor } from "./conductor";
