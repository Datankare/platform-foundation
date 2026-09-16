/**
 * platform/adaptive — ADR-036 adaptive behavior framework.
 * The platform owns the loop; consumers supply build/parse/schema/fallback per behavior.
 */
export type {
  AdaptiveBehavior,
  AnyAdaptiveBehavior,
  AdaptiveMemory,
  AdaptiveMemoryEntry,
} from "./types";
export {
  registerAdaptiveBehavior,
  getAdaptiveBehavior,
  hasAdaptiveBehavior,
  listAdaptiveBehaviors,
  resetAdaptiveBehaviors,
} from "./registry";
