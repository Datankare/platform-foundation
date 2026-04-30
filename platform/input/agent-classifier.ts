/**
 * platform/input/agent-classifier.ts — LLM-backed audio classifier
 *
 * Implements InputClassifier using the orchestrator for LLM classification.
 * Falls back to RuleBasedClassifier on any error (P11).
 *
 * P7:  Orchestrator-backed (swappable provider)
 * P11: Any LLM error → graceful fallback to rule-based
 * P12: Cost tracked per classification
 * P15: classifiedBy = "agent-classifier"
 *
 * @module platform/input
 */

import type { InputClassifier } from "./classifier";
import { RuleBasedClassifier, classificationToMode } from "./classifier";
import type { InputEvent, ClassificationResult, AudioFeatures } from "./types";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";
import {
  CLASSIFY_AUDIO_V1,
  buildClassifyAudioPrompt,
  parseClassifyAudioResponse,
} from "@/prompts/input/classify-audio-v1";
import { estimateCost } from "@/platform/ai/instrumentation";
import { logger } from "@/lib/logger";

/**
 * Agent-backed InputClassifier.
 *
 * Uses the orchestrator for LLM-based audio classification.
 * Non-audio events delegate to the rule-based fallback.
 * Any LLM error falls back to rule-based classification (P11).
 */
export class AgentClassifier implements InputClassifier {
  readonly name = "agent-classifier";

  private readonly orchestrator: Orchestrator;
  private readonly fallback: RuleBasedClassifier;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    this.fallback = new RuleBasedClassifier();
  }

  async classify(event: InputEvent): Promise<ClassificationResult> {
    if (event.type !== "mic") {
      return this.fallback.classify(event);
    }

    const startMs = Date.now();

    try {
      const description = event.text ?? "audio input from microphone";
      const prompt = buildClassifyAudioPrompt({
        description,
        durationMs: Date.now() - new Date(event.timestamp).getTime(),
      });

      const response: AIResponse = await this.orchestrator.complete(
        {
          tier: CLASSIFY_AUDIO_V1.tier,
          messages: [{ role: "user", content: prompt }],
          maxTokens: CLASSIFY_AUDIO_V1.maxTokens,
          temperature: CLASSIFY_AUDIO_V1.temperature,
        },
        {
          useCase: CLASSIFY_AUDIO_V1.name,
          requestId: event.requestId ?? "no-request-id",
        }
      );

      const raw =
        response.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("") || "{}";

      const parsed = parseClassifyAudioResponse(raw);
      const cost = estimateCost(
        CLASSIFY_AUDIO_V1.tier,
        response.usage.inputTokens,
        response.usage.outputTokens
      );

      const features: AudioFeatures = {
        rhythmRegularity: parsed.rhythmRegularity,
        harmonicContent: parsed.harmonicContent,
        speechCadence: parsed.speechCadence,
      };

      return {
        classification: parsed.classification,
        confidence: parsed.confidence,
        mode: classificationToMode(parsed.classification),
        features,
        classifiedBy: this.name,
        latencyMs: Date.now() - startMs,
        cost,
      };
    } catch (err) {
      logger.warn("Agent classifier failed — falling back to rule-based (P11)", {
        error: err instanceof Error ? err.message : "Unknown",
      });
      return this.fallback.classify(event);
    }
  }
}
