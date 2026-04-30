/**
 * platform/agents/agent-configs.ts — Platform agent configurations
 *
 * Registers all platform agents with the agent registry.
 * Called during provider initialization.
 *
 * P2:  Agents are configured, not coded
 * P12: Each agent has explicit budget constraints
 * P15: Each agent has a unique identity
 *
 * @module platform/agents
 */

import type { AgentConfig, BudgetConfig } from "./types";
import { registerAgent, hasAgent } from "./registry";

// ── Budget presets ────────────────────────────────────────────────────

/** Budget for agents that make LLM calls on every trigger */
const HIGH_FREQUENCY_BUDGET: BudgetConfig = {
  maxCostPerTrajectory: 0.05,
  maxCostPerDay: 10.0,
  maxStepsPerTrajectory: 10,
};

/** Budget for agents that run periodically or on-demand */
const SCHEDULED_BUDGET: BudgetConfig = {
  maxCostPerTrajectory: 0.25,
  maxCostPerDay: 5.0,
  maxStepsPerTrajectory: 15,
};

// ── Agent definitions ─────────────────────────────────────────────────

export const AGENT_CONFIGS: readonly AgentConfig[] = [
  // ── Social agents ───────────────────────────────────────────────
  {
    id: "guardian-social",
    name: "Guardian (Social)",
    description:
      "Screens all social content (group names, descriptions) for safety. Fail-closed.",
    tools: [],
    budgetConfig: HIGH_FREQUENCY_BUDGET,
    effortTier: "low",
  },
  {
    id: "matchmaker",
    name: "Matchmaker",
    description:
      "Recommends groups based on user interests, activity, and language preferences.",
    tools: [],
    budgetConfig: SCHEDULED_BUDGET,
    effortTier: "standard",
  },
  {
    id: "gatekeeper",
    name: "Gatekeeper",
    description:
      "Evaluates join requests against group criteria. Produces recommendations for admin review.",
    tools: [],
    budgetConfig: SCHEDULED_BUDGET,
    effortTier: "standard",
  },
  {
    id: "concierge",
    name: "Concierge",
    description:
      "Onboards new group members with guided first-time actions via ActionItem[] contract.",
    tools: [],
    budgetConfig: SCHEDULED_BUDGET,
    effortTier: "standard",
  },
  {
    id: "analyst",
    name: "Analyst",
    description:
      "Monitors group health, engagement metrics, and anomaly detection. Runs on schedule.",
    tools: [],
    budgetConfig: SCHEDULED_BUDGET,
    effortTier: "standard",
  },
  {
    id: "curator",
    name: "Curator",
    description:
      "Creates personalized content digests and activity summaries for group members.",
    tools: [],
    budgetConfig: SCHEDULED_BUDGET,
    effortTier: "standard",
  },

  // ── Input agents ────────────────────────────────────────────────
  {
    id: "audio-classifier",
    name: "Audio Classifier",
    description: "Classifies audio stream as speech, music, or noise using LLM analysis.",
    tools: [],
    budgetConfig: HIGH_FREQUENCY_BUDGET,
    effortTier: "low",
  },
  {
    id: "intent-resolver",
    name: "Intent Resolver",
    description: "Maps classified input + context to user intent and available actions.",
    tools: [],
    budgetConfig: HIGH_FREQUENCY_BUDGET,
    effortTier: "low",
  },
];

// ── Registration ──────────────────────────────────────────────────────

/**
 * Register all platform agents.
 * Safe to call multiple times — skips already-registered agents.
 */
export function registerPlatformAgents(): void {
  for (const config of AGENT_CONFIGS) {
    if (!hasAgent(config.id)) {
      registerAgent(config);
    }
  }
}
