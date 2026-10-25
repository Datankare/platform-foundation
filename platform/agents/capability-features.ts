/**
 * platform/agents/capability-features.ts — Reading the capability→feature map, fail closed
 * (review 12 H1)
 *
 * `agent.capability_features` maps an opaque capability name (ADR-030 D9) to the features a caller
 * must hold to use it: `[[capability, features[]], …]`. The platform governs the map (dual control,
 * power-reduction.ts); a consumer evaluates it. This is the evaluation every consumer must give:
 *
 *   - a capability ABSENT from the map is NOT allowed — never "no features required";
 *   - a map that is not a list of [capability, string[]] pairs, or that names a capability twice,
 *     allows nothing;
 *   - a mapped capability is allowed when the caller holds every feature it lists; a mapping with
 *     an empty list is an explicit "no features required" (an admin wrote it, under dual control).
 *
 * Before review 12, Playform's evaluateCapability read an absent capability as needing no
 * features — so removing a mapping removed the capability's user gate, and power-reduction.ts,
 * which then took a removal for a reduction, let one admin do it unheld. The platform now holds
 * every removal (it cannot know how a consumer reads the map), and states the contract here, with
 * a conformance kit consumers run against their own evaluator
 * (__tests__/contract/capability-features-contract.ts).
 *
 * @module platform/agents
 */

/** Why a capability is or is not allowed. */
export type CapabilityFeatureDecision =
  | { readonly allowed: true; readonly required: readonly string[] }
  | {
      readonly allowed: false;
      readonly reason: "unmapped" | "malformed_map" | "missing_features";
      readonly missing?: readonly string[];
    };

/**
 * The features `capability` requires, or null when the map does not map it or cannot be read
 * (both: not allowed).
 */
export function requiredFeatures(
  map: unknown,
  capability: string
): readonly string[] | null {
  const parsed = parseMap(map);
  if (!parsed) return null;
  return parsed.get(capability) ?? null;
}

/** Whether a caller holding `held` may use `capability` under `map` — fail closed. */
export function evaluateCapabilityFeatures(
  map: unknown,
  capability: string,
  held: Iterable<string>
): CapabilityFeatureDecision {
  const parsed = parseMap(map);
  if (!parsed) return { allowed: false, reason: "malformed_map" };
  const required = parsed.get(capability);
  if (!required) return { allowed: false, reason: "unmapped" };
  const have = new Set(held);
  const missing = required.filter((f) => !have.has(f));
  return missing.length
    ? { allowed: false, reason: "missing_features", missing }
    : { allowed: true, required };
}

/** Whether `map` is a well-formed capability map (a malformed one allows nothing). */
export function isWellFormedCapabilityMap(map: unknown): boolean {
  return parseMap(map) !== null;
}

/** The map as capability → features, or null when it is not a well-formed one. */
function parseMap(map: unknown): Map<string, readonly string[]> | null {
  if (!Array.isArray(map)) return null;
  const out = new Map<string, readonly string[]>();
  for (const pair of map) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !Array.isArray(pair[1]) ||
      !pair[1].every((f: unknown) => typeof f === "string")
    ) {
      return null;
    }
    if (out.has(pair[0])) return null;
    out.set(pair[0], pair[1] as string[]);
  }
  return out;
}
