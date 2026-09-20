/**
 * platform/adaptive/bootstrap.ts — live activation of the reference adaptive behavior (ADR-036).
 *
 * Called from initProviders() (platform/providers) at server boot, so the reference host agent and
 * behavior are registered on the same path every other platform singleton is initialized on — the
 * activation Playform (the first consumer) inherits. Idempotent: safe to call more than once
 * (boot + per-test-file mirror in jest.setup), and it never double-registers.
 *
 * @module platform/adaptive
 */

import { registerAgent, hasAgent } from "@/platform/agents";
import { PACING_HOST_AGENT, PACING_BEHAVIOR } from "./behaviors/pacing";
import { registerAdaptiveBehavior, hasAdaptiveBehavior } from "./registry";

/** Register the reference adaptive behavior and its host agent. Idempotent. */
export function registerAdaptiveReference(): void {
  if (!hasAgent(PACING_HOST_AGENT.id)) {
    registerAgent(PACING_HOST_AGENT);
  }
  if (!hasAdaptiveBehavior(PACING_BEHAVIOR.name)) {
    registerAdaptiveBehavior(PACING_BEHAVIOR);
  }
}
