/**
 * prompts/index.ts — Prompt registry with version resolution
 *
 * ADR-015: Prompts are first-class artifacts with version tracking.
 * All prompts are registered here — no inline prompt strings in routes.
 *
 * Usage:
 *   import { getPromptConfig } from "@/prompts";
 *   const config = getPromptConfig("safety-classify");
 *   // → { name, version, tier, maxTokens }
 */

import { ModelTier } from "@/platform/ai/types";
import { SAFETY_CLASSIFY_V1 } from "./safety/classify-v1";
import { ADMIN_COMMAND_BAR_V1 } from "./admin/command-bar-v1";
import { CONFIG_MANAGER_V1 } from "./admin/config-manager-v1";
import { CLASSIFY_AUDIO_V1 } from "./input/classify-audio-v1";
import { RESOLVE_INTENT_V1 } from "./input/resolve-intent-v1";
import { ANALYST_V1 } from "./social/analyst-v1";
import { CONCIERGE_V1 } from "./social/concierge-v1";
import { CURATOR_V1 } from "./social/curator-v1";
import { GATEKEEPER_V1 } from "./social/gatekeeper-v1";
import { MATCHMAKER_V1 } from "./social/matchmaker-v1";
import { PACING_V1 } from "./adaptive/pacing-v1";

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export interface PromptConfig {
  name: string;
  version: number;
  tier: ModelTier;
  maxTokens: number;
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Prompt catalog — maps prompt names to their latest config.
 * When a new version is added (e.g., classify-v2), update the
 * entry here to point to the new version.
 */
const PROMPT_REGISTRY: Record<string, PromptConfig> = {
  "safety-classify": SAFETY_CLASSIFY_V1,
  "admin-command-bar": ADMIN_COMMAND_BAR_V1,
  "config-manager": CONFIG_MANAGER_V1,
  "classify-audio": CLASSIFY_AUDIO_V1,
  "resolve-intent": RESOLVE_INTENT_V1,
  analyst: ANALYST_V1,
  concierge: CONCIERGE_V1,
  curator: CURATOR_V1,
  gatekeeper: GATEKEEPER_V1,
  matchmaker: MATCHMAKER_V1,
  "adaptive-pacing": PACING_V1,
};

/**
 * Get the current config for a named prompt.
 * Throws if the prompt name is not registered.
 */
export function getPromptConfig(name: string): PromptConfig {
  const config = PROMPT_REGISTRY[name];
  if (!config) {
    throw new Error(
      `Unknown prompt: "${name}". Registered prompts: ${Object.keys(PROMPT_REGISTRY).join(", ")}`
    );
  }
  return config;
}

/** List all registered prompt names */
export function listPrompts(): string[] {
  return Object.keys(PROMPT_REGISTRY);
}

// Re-export prompt builders for convenience
export { buildSafetyPrompt, parseClassifierResponse } from "./safety/classify-v1";
export type {
  SafetyCategory,
  SafetySeverity,
  ClassifierOutput,
} from "./safety/classify-v1";
export { buildAdminSystemPrompt } from "./admin/command-bar-v1";
