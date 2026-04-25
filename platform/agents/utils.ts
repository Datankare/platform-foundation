/**
 * platform/agents/utils.ts — Shared agent utilities
 *
 * Functions used across multiple agents (Guardian, Sentinel, etc.)
 * to avoid duplication (sustainability gate A5).
 *
 * @module platform/agents
 */

/**
 * Generate a short random ID for agent instances, trajectories, etc.
 * Not cryptographically secure — for tracing and correlation, not auth.
 */
export function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}
