/**
 * platform/agents/agent-configs.ts — Platform agent configurations
 *
 * The core's agents, and their registration with the registered modules' agents (ADR-054 D4 —
 * a module's agents are declared in its definition, e.g. the five social agents in
 * platform/social/module.ts). Called during provider initialization.
 *
 * P2:  Agents are configured, not coded
 * P12: Each agent has explicit budget constraints
 * P15: Each agent has a unique identity
 *
 * @module platform/agents
 */

import type { AgentConfig, BudgetConfig } from "./types";
import { registerAgent, hasAgent } from "./registry";
import { composeValues } from "@/platform/modules/compose";

// ── Budget presets ────────────────────────────────────────────────────

/** Budget for agents that make LLM calls on every trigger */
export const HIGH_FREQUENCY_BUDGET: BudgetConfig = {
  maxCostPerTrajectory: 0.05,
  maxCostPerDay: 10.0,
  maxStepsPerTrajectory: 10,
};

/** Budget for agents that run periodically or on-demand */
export const SCHEDULED_BUDGET: BudgetConfig = {
  maxCostPerTrajectory: 0.25,
  maxCostPerDay: 5.0,
  maxStepsPerTrajectory: 15,
};

// ── Agent definitions ─────────────────────────────────────────────────

export const AGENT_CONFIGS: readonly AgentConfig[] = [
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

  // ── Moderation agents ───────────────────────────────────────────
  // Guardian screens every piece of content the platform handles, not only social content: it
  // runs every screening under this id (platform/moderation/guardian.ts). The id predates the
  // module split and is kept because trajectories, budgets and audit records carry it; the
  // agent is the core's (ADR-054 — the social module's agents are its own five).
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
    id: "sentinel",
    name: "Sentinel",
    description:
      "Processes Guardian block decisions and runs the account-consequences ladder " +
      "(warn -> suspend -> ban). Rule-based; no LLM calls.",
    tools: [],
    budgetConfig: HIGH_FREQUENCY_BUDGET,
    effortTier: "low",
  },

  // ── Admin agents ────────────────────────────────────────────────
  {
    id: "config-manager",
    name: "Config Manager",
    description:
      "GenAI-native admin agent for platform configuration: search, inspect, compare, " +
      "impact-assess, and change config behind a confirmation gate and two-person approval.",
    tools: [],
    budgetConfig: SCHEDULED_BUDGET,
    effortTier: "standard",
  },
  {
    id: "command-bar",
    name: "Admin Command Bar",
    description:
      "GenAI-native admin command bar: plans natural-language admin requests into governed " +
      "tool calls across roles, entitlements, restrictions, capability mapping, approval, and search.",
    tools: [],
    budgetConfig: SCHEDULED_BUDGET,
    effortTier: "standard",
  },

  // ── Input agents (orchestrator) ─────────────────────────────────
  {
    id: "conductor",
    name: "Conductor",
    description:
      "Top-level input orchestrator: classifies raw input, resolves intent, and emits unified " +
      "output. Delegates to the audio-classifier and intent-resolver agents.",
    tools: [],
    budgetConfig: HIGH_FREQUENCY_BUDGET,
    effortTier: "low",
  },
];

// ── Registration ──────────────────────────────────────────────────────

/** The core's agents then each registered module's, each id once (refused otherwise). */
export function listPlatformAgentConfigs(): readonly AgentConfig[] {
  return composeValues(
    "agent",
    AGENT_CONFIGS,
    (a) => a.id,
    (m) => m.agents
  );
}

/**
 * Register the core's agents and the registered modules' agents.
 * Safe to call multiple times — skips already-registered agents.
 */
export function registerPlatformAgents(): void {
  for (const config of listPlatformAgentConfigs()) {
    if (!hasAgent(config.id)) {
      registerAgent(config);
    }
  }
}
