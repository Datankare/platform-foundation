/**
 * platform/content/effect.ts — routing durable content surfacing (ADR-037 D5).
 *
 * Surfacing durable content is commitment — the P17 boundary. The content is routed as an ordinary
 * governed effect: applied (committed and surfaced) when the risk gate allows, held when approval
 * is required, rejected or conflict otherwise — no privileged route around the controls. The
 * routing is the same platform-wide primitive the adaptive effect uses (platform/effects); this
 * module is the content-named surface over it.
 */
export { routeGovernedEffect as routeContentEffect } from "@/platform/effects";
export type {
  GovernedEffectStatus as ContentEffectStatus,
  GovernedEffectOutcome as ContentEffectOutcome,
  GovernedEffectRequest as ContentEffectRequest,
} from "@/platform/effects";
