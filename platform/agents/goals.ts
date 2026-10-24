/**
 * platform/agents/goals.ts — The workflow goals this app implements (ADR-030 D1, ADR-054 D4)
 *
 * AgentGoal is an open string type: the core declares its own goals here, and each module the
 * app registers declares the goals of the features it adds (translation: "translate"; song-id:
 * "identify-song"; …). registerWorkflow refuses a goal outside this set, so a workflow for a
 * module that is not registered — or a misspelt goal — fails at registration, not at the first
 * request that asks for it.
 *
 * @module platform/agents
 */

import type { CoreAgentGoal } from "@/platform/kernel/types";
import { composeValues } from "@/platform/modules/compose";

/** The goals the core implements itself. */
export const CORE_AGENT_GOALS: readonly CoreAgentGoal[] = Object.freeze(["analyze"]);

/** The core's goals then each registered module's, each once (refused otherwise). */
export function listAgentGoals(): readonly string[] {
  return composeValues<string>(
    "workflow goal",
    CORE_AGENT_GOALS,
    (g) => g,
    (m) => m.goals
  );
}

/** Whether the core or a registered module declares `goal`. */
export function isAgentGoal(goal: string): boolean {
  return listAgentGoals().includes(goal);
}
