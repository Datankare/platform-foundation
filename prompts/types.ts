/**
 * prompts/types.ts — Prompt registry types (ADR-015)
 *
 * A leaf, so the module definitions (platform/modules) can declare prompts without importing the
 * registry that reads them.
 */

import type { ModelTier } from "@/platform/ai/types";

/** A registered prompt's current version and model settings. */
export interface PromptConfig {
  name: string;
  version: number;
  tier: ModelTier;
  maxTokens: number;
  temperature?: number;
}
