/**
 * platform/effects — shared platform primitives for routing governed effects.
 * Used by the adaptive framework (ADR-036) and the content framework (ADR-037).
 */
export { routeGovernedEffect } from "./route";
export type {
  GovernedEffectStatus,
  GovernedEffectOutcome,
  GovernedEffectRequest,
} from "./route";
