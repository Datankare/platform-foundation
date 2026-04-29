/**
 * platform/agents/registry.ts — Agent registry
 *
 * Register and look up agents by name. Each agent has a config
 * that defines its identity, tools, and budget constraints.
 *
 * P2:  Agents are configured, not coded — runtime reads config
 * P5:  Versioned — agent configs are typed and registerable
 * P15: Agent identity — every registered agent has a unique ID
 *
 * @module platform/agents
 */

import type { AgentConfig } from "./types";

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const agents = new Map<string, AgentConfig>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register an agent configuration.
 * Throws if an agent with the same ID is already registered.
 */
export function registerAgent(config: AgentConfig): void {
  if (agents.has(config.id)) {
    throw new Error(`Agent already registered: ${config.id}`);
  }
  agents.set(config.id, config);
}

/**
 * Get an agent configuration by ID.
 * Returns undefined if not registered.
 */
export function getAgent(agentId: string): AgentConfig | undefined {
  return agents.get(agentId);
}

/**
 * Check if an agent is registered.
 */
export function hasAgent(agentId: string): boolean {
  return agents.has(agentId);
}

/**
 * List all registered agent IDs.
 */
export function listAgents(): readonly string[] {
  return [...agents.keys()];
}

/**
 * Unregister an agent. Returns true if it existed.
 */
export function unregisterAgent(agentId: string): boolean {
  return agents.delete(agentId);
}

/**
 * Clear all registrations (testing only).
 */
export function resetAgentRegistry(): void {
  agents.clear();
}
