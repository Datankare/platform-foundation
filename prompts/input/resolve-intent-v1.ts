/**
 * prompts/input/resolve-intent-v1.ts — Intent resolution prompt
 *
 * Maps classified input + context to user intent and available actions.
 * Returns structured intent with ActionItem[] for the UI.
 *
 * P6:  Structured JSON output matching IntentResult/ActionItem contracts
 * P10: Actions are suggestions — user decides
 * P11: Fail-closed parse → unknown intent with generic actions
 *
 * @module prompts/input
 */

import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger } from "@/lib/logger";

/** Input for intent resolution */
export interface ResolveIntentInput {
  readonly classification: string;
  readonly mode: string;
  readonly confidence: number;
  readonly userContext: string;
}

/** Resolved intent from LLM */
export interface ResolvedIntent {
  readonly intent: string;
  readonly displayLabel: string;
  readonly confidence: number;
  readonly actions: readonly { id: string; label: string; primary: boolean }[];
}

/** Prompt configuration */
export const RESOLVE_INTENT_V1 = {
  name: "resolve-intent",
  version: 1,
  tier: "fast" as const,
  maxTokens: 256,
  temperature: 0.1,
} as const;

/**
 * Build the intent resolution prompt.
 */
export function buildResolveIntentPrompt(input: ResolveIntentInput): string {
  return `You are an intent resolution agent. Given a classified input and user context, determine what the user wants to do and suggest available actions.

Classification: ${sanitizeForPrompt(input.classification)}
Mode: ${sanitizeForPrompt(input.mode)}
Confidence: ${input.confidence}
User context: ${sanitizeForPrompt(input.userContext)}

Respond with ONLY a JSON object. No markdown, no code fences, no explanation.
{
  "intent": "machine-readable-intent",
  "displayLabel": "Human readable label",
  "confidence": 0.0-1.0,
  "actions": [
    { "id": "action-id", "label": "Button label", "primary": true/false }
  ]
}

Rules:
- intent: kebab-case, descriptive (e.g., "translate-text", "identify-song")
- displayLabel: friendly description for the UI intent bar
- actions: 1-4 available actions, exactly one should be primary
- For speech mode: suggest translate, transcribe actions
- For music mode: suggest identify, save actions
- For text mode: suggest send, format actions
- When uncertain, provide generic actions`;
}

/**
 * Parse intent response. Fail-closed: returns unknown intent.
 */
export function parseResolveIntentResponse(raw: string): ResolvedIntent {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const result = JSON.parse(cleaned);

    const intent = typeof result.intent === "string" ? result.intent : "unknown";
    const displayLabel =
      typeof result.displayLabel === "string" ? result.displayLabel : "Processing...";
    const confidence =
      typeof result.confidence === "number"
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.5;

    const actions = Array.isArray(result.actions)
      ? result.actions
          .filter(
            (a: Record<string, unknown>) =>
              typeof a.id === "string" &&
              typeof a.label === "string" &&
              typeof a.primary === "boolean"
          )
          .slice(0, 4)
          .map((a: Record<string, unknown>) => ({
            id: a.id as string,
            label: a.label as string,
            primary: a.primary as boolean,
          }))
      : [];

    return { intent, displayLabel, confidence, actions };
  } catch {
    logger.debug("Prompt parse failed — returning safe default", { raw: cleaned });
    return {
      intent: "unknown",
      displayLabel: "Processing...",
      confidence: 0,
      actions: [],
    };
  }
}
