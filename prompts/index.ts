/**
 * prompts/index.ts — Prompt registry with version resolution
 *
 * ADR-015: Prompts are first-class artifacts with version tracking.
 * The core's prompts are registered here; a module's prompts are declared in its definition
 * (ADR-054 D4 — e.g. the social agents' prompts, platform/social/module.ts) and added when the
 * app registers it. No inline prompt strings in routes.
 *
 * Usage:
 *   import { getPromptConfig } from "@/prompts";
 *   const config = getPromptConfig("safety-classify");
 *   // → { name, version, tier, maxTokens }
 */

import { composeValues } from "@/platform/modules/compose";
import type { PromptConfig } from "./types";
import { SAFETY_CLASSIFY_V1 } from "./safety/classify-v1";
import { ADMIN_COMMAND_BAR_V1 } from "./admin/command-bar-v1";
import { CONFIG_MANAGER_V1 } from "./admin/config-manager-v1";
import { CLASSIFY_AUDIO_V1 } from "./input/classify-audio-v1";
import { RESOLVE_INTENT_V1 } from "./input/resolve-intent-v1";
import { PACING_V1 } from "./adaptive/pacing-v1";
import { STREAM_ASSISTANT_V1 } from "./assistant/stream-v1";

export type { PromptConfig } from "./types";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The core's prompt catalog — each prompt's latest config. When a new version is added (e.g.,
 * classify-v2), point its entry here at the new version.
 */
const CORE_PROMPTS: readonly PromptConfig[] = [
  SAFETY_CLASSIFY_V1,
  ADMIN_COMMAND_BAR_V1,
  CONFIG_MANAGER_V1,
  CLASSIFY_AUDIO_V1,
  RESOLVE_INTENT_V1,
  PACING_V1,
  STREAM_ASSISTANT_V1,
];

/** The core's prompts then the registered modules', each name once (refused otherwise). */
function registeredPrompts(): readonly PromptConfig[] {
  return composeValues(
    "prompt",
    CORE_PROMPTS,
    (p) => p.name,
    (m) => m.prompts
  );
}

/**
 * Get the current config for a named prompt.
 * Throws if the prompt name is not registered.
 */
export function getPromptConfig(name: string): PromptConfig {
  const prompts = registeredPrompts();
  const config = prompts.find((p) => p.name === name);
  if (!config) {
    throw new Error(
      `Unknown prompt: "${name}". Registered prompts: ${prompts.map((p) => p.name).join(", ")}`
    );
  }
  return config;
}

/** List all registered prompt names: the core's, then each registered module's. */
export function listPrompts(): string[] {
  return registeredPrompts().map((p) => p.name);
}

// Re-export prompt builders for convenience
export { buildSafetyPrompt, parseClassifierResponse } from "./safety/classify-v1";
export type {
  SafetyCategory,
  SafetySeverity,
  ClassifierOutput,
} from "./safety/classify-v1";
export { buildAdminSystemPrompt } from "./admin/command-bar-v1";
export { buildStreamSystemPrompt } from "./assistant/stream-v1";
