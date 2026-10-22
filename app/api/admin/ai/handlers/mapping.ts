/**
 * app/api/admin/ai/handlers/mapping.ts — capability→feature mapping handler (Sprint 3c U3).
 *
 * GenAI-native governance admin (ADR-035) over the agent.capability_features config store. The
 * store is a json_array of [capability, features[]] pairs; the handler reads it, sets or
 * removes one capability's feature list, and writes it back through writeGovernedConfig — the
 * key's tier permission, validation, history, two-person approval and dual control (audit X-7).
 * Vocabulary-free — capability and feature names are opaque strings the handler does not
 * enumerate.
 */

import { getConfig } from "@/platform/auth/platform-config";
import { writeGovernedConfig } from "@/platform/admin/governed-config";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { fromGovernedConfig, type ActionResult } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CAPABILITY_FEATURES_KEY = "agent.capability_features";

async function readPairs(): Promise<[string, string[]][]> {
  const pairs = await getConfig<[string, string[]][]>(CAPABILITY_FEATURES_KEY, []);
  return Array.isArray(pairs)
    ? pairs.map(([c, f]) => [c, Array.isArray(f) ? f : []])
    : [];
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
