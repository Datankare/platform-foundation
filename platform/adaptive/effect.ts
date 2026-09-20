/**
 * platform/adaptive/effect.ts — routing an adaptive decision's effect (ADR-036 D4).
 *
 * runAdaptive has no state-mutation path: the loop produces a validated decision and mutates
 * nothing but its own within-session memory. When a decision is effectful, the consumer routes it
 * here — the single governed path — which forces boundary "commitment" (P17) and runs the D3
 * pipeline. The routing itself is the platform-wide governed-effect primitive (platform/effects,
 * shared with the content framework); this module is the adaptive-named surface over it.
 */
export { routeGovernedEffect as routeAdaptiveEffect } from "@/platform/effects";
export type {
  GovernedEffectStatus as AdaptiveEffectStatus,
  GovernedEffectOutcome as AdaptiveEffectOutcome,
  GovernedEffectRequest as AdaptiveEffectRequest,
} from "@/platform/effects";
