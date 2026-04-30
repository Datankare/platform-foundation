/**
 * platform/input/agent-intent.ts — LLM-backed intent resolver
 *
 * Implements IntentResolver using the orchestrator for LLM resolution.
 * Falls back to DefaultIntentResolver on any error (P11).
 *
 * P7:  Orchestrator-backed (swappable provider)
 * P10: Actions are suggestions — user decides
 * P11: Any LLM error → graceful fallback to rule-based
 * P12: Cost tracked per resolution
 * P15: resolvedBy = "agent-intent"
 *
 * @module platform/input
 */

import type { IntentResolver, IntentContext } from "./intent";
import { DefaultIntentResolver } from "./intent";
import type { ClassificationResult, IntentResult, ActionItem } from "./types";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";
import {
  RESOLVE_INTENT_V1,
  buildResolveIntentPrompt,
  parseResolveIntentResponse,
} from "@/prompts/input/resolve-intent-v1";
import { estimateCost } from "@/platform/ai/instrumentation";
import { logger } from "@/lib/logger";

/**
 * Agent-backed IntentResolver.
 *
 * Uses the orchestrator for LLM-based intent resolution.
 * Any LLM error falls back to the default rule-based resolver (P11).
 */
export class AgentIntentResolver implements IntentResolver {
  readonly name = "agent-intent";

  private readonly orchestrator: Orchestrator;
  private readonly fallback: DefaultIntentResolver;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    this.fallback = new DefaultIntentResolver();
  }

  async resolve(
    classification: ClassificationResult,
    context: IntentContext
  ): Promise<IntentResult> {
    const startMs = Date.now();

    try {
      const prompt = buildResolveIntentPrompt({
        classification: classification.classification,
        mode: classification.mode,
        confidence: classification.confidence,
        userContext: context.currentMode ?? "unknown",
      });

      const response: AIResponse = await this.orchestrator.complete(
        {
          tier: RESOLVE_INTENT_V1.tier,
          messages: [{ role: "user", content: prompt }],
          maxTokens: RESOLVE_INTENT_V1.maxTokens,
          temperature: RESOLVE_INTENT_V1.temperature,
        },
        {
          useCase: RESOLVE_INTENT_V1.name,
          requestId: `intent-${Date.now()}`,
        }
      );

      const raw =
        response.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("") || "{}";

      const parsed = parseResolveIntentResponse(raw);
      const cost = estimateCost(
        RESOLVE_INTENT_V1.tier,
        response.usage.inputTokens,
        response.usage.outputTokens
      );

      const actions: readonly ActionItem[] = parsed.actions.map((a) => ({
        id: a.id,
        label: a.label,
        primary: a.primary,
      }));

      return {
        intent: parsed.intent,
        displayLabel: parsed.displayLabel,
        confidence: parsed.confidence,
        actions,
        resolvedBy: this.name,
        latencyMs: Date.now() - startMs,
        cost,
      };
    } catch (err) {
      logger.warn("Agent intent resolver failed — falling back to rule-based (P11)", {
        error: err instanceof Error ? err.message : "Unknown",
      });
      return this.fallback.resolve(classification, context);
    }
  }
}
