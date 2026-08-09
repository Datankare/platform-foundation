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

  // ADR-029 D6: a workflow containing a non-compensable step is refused HERE, not
  // discovered mid-rollback. The compensation model requires every irreversible step to be
  // declared as such, and the ADR is explicit that this will be got wrong at least once —
  // which is an argument for failing at registration, where it is cheap, rather than
  // part-way through an unwind, where it is not.
  const irreversible = config.tools.filter((t) => t.compensable === false);
  if (irreversible.length > 0) {
    throw new Error(
      `Agent ${config.id} declares non-compensable tool(s): ` +
        `${irreversible.map((t) => t.id).join(", ")}. ` +
        "A workflow containing an uncompensable step cannot be rolled back (ADR-029 D6)."
    );
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
