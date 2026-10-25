/**
 * platform/agents/governed-agent-config.ts — Reading the agent registry and the capability map,
 * fail closed (review 13 P)
 *
 * `agent.trusted_agents` (which agents exist, their owner, scopes, status and token lifetime) and
 * `agent.capability_features` (what features a capability needs, capability-features.ts) decide
 * what an agent may do. A read of either that cannot be had must never be answered with a default:
 * an empty registry or map read as "nothing configured" either lets a consumer fall back to a
 * built-in, permissive map, or — written back by an admin handler — erases every entry (audit
 * B-21). So these readers have getConfigOrThrow semantics: the stored value, or
 * GovernedAgentConfigUnreadableError. Every platform read of these keys goes through them; a
 * consuming app reading either key MUST use them too (docs/MIGRATION_v5_to_v6.md §1b), and treat
 * the error — and a value that is not well formed — as "deny", never as "use a built-in map".
 *
 * `evaluateGovernedCapability` is the whole consumer decision for one capability: read the map (fail
 * closed), then evaluate it (evaluateCapabilityFeatures: an unmapped capability is not allowed).
 *
 * @module platform/agents
 */

import {
  evaluateCapabilityFeatures,
  isWellFormedCapabilityMap,
  type CapabilityFeatureDecision,
} from "@/platform/agents/capability-features";

export const TRUSTED_AGENTS_KEY = "agent.trusted_agents";
export const CAPABILITY_FEATURES_KEY = "agent.capability_features";

/** The agent registry or the capability map could not be read: deny, never default. */
export class GovernedAgentConfigUnreadableError extends Error {
  readonly code = "service.unavailable";
  constructor(
    readonly key: string,
    cause: unknown
  ) {
    super(
      `"${key}" could not be read, so nothing it governs is allowed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
    this.name = "GovernedAgentConfigUnreadableError";
  }
}

async function readOrThrow(key: string): Promise<unknown> {
  // Lazy: the config service binds the data layer; this module stays importable without it.
  const { getConfigOrThrow } = await import("@/platform/auth/platform-config");
  try {
    return await getConfigOrThrow<unknown>(key);
  } catch (err) {
    throw new GovernedAgentConfigUnreadableError(key, err);
  }
}

/** The stored agent registry (as stored — the caller checks its shape), or throws. */
export function readTrustedAgents(): Promise<unknown> {
  return readOrThrow(TRUSTED_AGENTS_KEY);
}

/** The stored capability map (as stored — evaluate it with capability-features.ts), or throws. */
export function readCapabilityFeatures(): Promise<unknown> {
  return readOrThrow(CAPABILITY_FEATURES_KEY);
}

/** Why a capability decision was made, including that the map could not be read. */
export type GovernedCapabilityDecision =
  | CapabilityFeatureDecision
  | { readonly allowed: false; readonly reason: "config_unreadable" };

/**
 * Whether a caller holding `held` may use `capability`: the governed map, read fail closed, and
 * evaluated fail closed. Never throws.
 */
export async function evaluateGovernedCapability(
  capability: string,
  held: Iterable<string>
): Promise<GovernedCapabilityDecision> {
  let map: unknown;
  try {
    map = await readCapabilityFeatures();
  } catch {
    return { allowed: false, reason: "config_unreadable" };
  }
  return evaluateCapabilityFeatures(map, capability, held);
}

/**
 * Whether a stored agent registry is well formed for display (review 14 L-1): a list of
 * `[agentId, record]` pairs, each id a non-empty string named once, each record an object. A value
 * that is not — a hand-edited row, a failed migration — is answered 503, never shown as an empty
 * registry ("No agents registered" for a registry that could not be read).
 */
export function isWellFormedTrustedAgents(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const [id, record] = pair as [unknown, unknown];
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) return false;
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Whether a stored capability map is well formed (the evaluation's own test: a list of
 * `[capability, string[]]` pairs, no capability twice — capability-features.ts). Review 14 L-1.
 */
export { isWellFormedCapabilityMap };
