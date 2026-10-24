/**
 * platform/social/agent-configs.ts — The social module's agents (ADR-021, ADR-054 D2)
 *
 * Moved out of the core's agent-configs.ts: the core never names a module's agents. Registered
 * with the core's by registerPlatformAgents() once the app registers the social module.
 * (Guardian's "guardian-social" agent stays in the core — Guardian screens every kind of content.)
 *
 * P2:  Agents are configured, not coded
 * P12: Each agent has explicit budget constraints
 * P15: Each agent has a unique identity
 *
 * @module platform/social
 */

import type { AgentConfig } from "@/platform/agents/types";
import { SCHEDULED_BUDGET } from "@/platform/agents/agent-configs";

export const SOCIAL_AGENT_CONFIGS: readonly AgentConfig[] = [
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
];
