/**
 * platform/agents/tools.ts — Tool registry
 *
 * Register and look up typed tool definitions that agents can use.
 * Tools are versioned artifacts (P5) with explicit input/output schemas.
 *
 * P5: Versioned artifacts — tools are registered, not inline
 * P6: Structured outputs — schemas enforce contracts
 *
 * @module platform/agents
 */

import type { Tool } from "./types";

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const tools = new Map<string, Tool>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a tool definition.
 * Throws if a tool with the same ID is already registered.
 */
export function registerTool(tool: Tool): void {
  if (tools.has(tool.id)) {
    throw new Error(`Tool already registered: ${tool.id}`);
  }
  tools.set(tool.id, tool);
}

/**
 * Get a tool definition by ID.
 * Returns undefined if not registered.
 */
export function getTool(toolId: string): Tool | undefined {
  return tools.get(toolId);
}

/**
 * Check if a tool is registered.
 */
export function hasTool(toolId: string): boolean {
  return tools.has(toolId);
}

/**
 * List all registered tool IDs.
 */
export function listTools(): readonly string[] {
  return [...tools.keys()];
}

/**
 * Get tool definitions for a list of tool IDs.
 *
 * Throws on an unregistered ID (ADR-029 D1). A missing tool is a misconfiguration, and an
 * agent silently running with reduced capability is worse than an agent that refuses to
 * start: the first produces wrong answers indefinitely, the second produces one loud
 * failure at registration.
 *
 * The previous implementation skipped unknown IDs, and the docstring claimed it logged a
 * warning it never logged — the same fail-open shape as TASK-057.
 */
export function resolveTools(toolIds: readonly string[]): readonly Tool[] {
  const resolved: Tool[] = [];
  for (const id of toolIds) {
    const tool = tools.get(id);
    if (!tool) {
      throw new Error(`Tool not registered: ${id}`);
    }
    resolved.push(tool);
  }
  return resolved;
}

/**
 * Clear all registrations (testing only).
 */
export function resetToolRegistry(): void {
  tools.clear();
}
