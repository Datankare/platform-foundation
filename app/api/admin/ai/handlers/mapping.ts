/**
 * app/api/admin/ai/handlers/mapping.ts — capability→feature mapping handler (Sprint 3c U3).
 *
 * GenAI-native governance admin (ADR-035) over the agent.capability_features config store. The
 * store is a json_array of [capability, features[]] pairs; the handler reads it, sets or
 * removes one capability's feature list, and writes it back through writeGovernedConfig — the
 * key's tier permission, validation, history, two-person approval and dual control (audit X-7).
 * Vocabulary-free — capability and feature names are opaque strings the handler does not
 * enumerate.
 *
 * One hold, the key's (review 10 H1, H3): set_capability_mapping is a config write
 * (COMMAND_BAR_CONFIG_WRITES, command-bar.ts), never held as an action; a write to a
 * dual-controlled key is held by the config writer under the key's own rules, and the command bar
 * reports it held.
 */

import {
  CAPABILITY_FEATURES_KEY,
  readCapabilityFeatures,
} from "@/platform/agents/governed-agent-config";
import { writeGovernedConfig } from "@/platform/admin/governed-config";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { fromGovernedConfig, type ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export { CAPABILITY_FEATURES_KEY };

/**
 * The map as [capability, features[]] pairs, or null when it cannot be read or is not that shape
 * (review 13 P). Never an empty list in place of an unreadable one: the handler writes the whole
 * list back, so "unreadable" read as "empty" would erase every mapping (as audit B-21 found for
 * the agent registry). A copy: the handler changes it in place.
 */
async function readPairs(): Promise<[string, string[]][] | null> {
  let pairs: unknown;
  try {
    pairs = await readCapabilityFeatures();
  } catch {
    return null;
  }
  if (!Array.isArray(pairs)) return null;
  const wellFormed = pairs.every(
    (p) =>
      Array.isArray(p) &&
      p.length === 2 &&
      typeof p[0] === "string" &&
      Array.isArray(p[1]) &&
      (p[1] as unknown[]).every((f) => typeof f === "string")
  );
  return wellFormed ? structuredClone(pairs as [string, string[]][]) : null;
}

/**
 * Set the required-feature list for a capability, or remove the mapping when remove=true.
 * Setting an existing capability replaces its list; setting a new one appends it.
 */
export async function handleSetCapabilityMapping(
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult> {
  const capability: string = input.capability;
  if (!capability) return { success: false, error: "capability is required" };
  const remove: boolean = input.remove === true;

  const pairs = await readPairs();
  if (!pairs) {
    return {
      success: false,
      error: "The capability map could not be read, so nothing was changed.",
    };
  }
  const idx = pairs.findIndex(([c]) => c === capability);

  let summary: string;
  if (remove) {
    if (idx === -1) return { success: false, error: `No mapping for "${capability}"` };
    pairs.splice(idx, 1);
    summary = `Removed capability mapping "${capability}"`;
  } else {
    const features: string[] = Array.isArray(input.features) ? input.features : [];
    if (features.length === 0) {
      return {
        success: false,
        error: "features must be a non-empty list (or use remove)",
      };
    }
    if (idx === -1) pairs.push([capability, features]);
    else pairs[idx][1] = features;
    summary = `Mapped "${capability}" to [${features.join(", ")}]`;
  }

  const outcome = await writeGovernedConfig(admin, {
    key: CAPABILITY_FEATURES_KEY,
    value: pairs,
    changeComment: `Command bar: ${summary}`,
  });
  return fromGovernedConfig(outcome, CAPABILITY_FEATURES_KEY, summary);
}
