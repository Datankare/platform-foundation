/**
 * prompts/input/classify-audio-v1.ts — Audio classification prompt
 *
 * Classifies audio input as speech, music, or noise via LLM.
 * Returns structured classification with confidence.
 *
 * P6:  Structured JSON output
 * P11: Fail-closed parse → "noise" classification
 * P15: Agent identity tracked via classifiedBy
 *
 * @module prompts/input
 */

import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger } from "@/lib/logger";

/** Input for audio classification */
export interface ClassifyAudioInput {
  readonly description: string;
  readonly durationMs: number;
}

/** Prompt configuration */
export const CLASSIFY_AUDIO_V1 = {
  name: "classify-audio",
  version: 1,
  tier: "fast" as const,
  maxTokens: 128,
  temperature: 0,
} as const;

/**
 * Build the audio classification prompt.
 */
export function buildClassifyAudioPrompt(input: ClassifyAudioInput): string {
  return `You are an audio classification agent. Given a description of audio input, classify it as speech, music, or noise.

Audio description: ${sanitizeForPrompt(input.description)}
Duration: ${input.durationMs}ms

Respond with ONLY a JSON object. No markdown, no code fences, no explanation.
{
  "classification": "speech" | "music" | "noise",
  "confidence": 0.0-1.0,
  "rhythmRegularity": 0.0-1.0,
  "harmonicContent": 0.0-1.0,
  "speechCadence": 0.0-1.0
}

Rules:
- "speech": human voice, spoken words, conversation
- "music": melodic content, instruments, singing with accompaniment
- "noise": ambient sound, static, unclear audio
- confidence: your certainty in the classification
- Feature scores: estimate based on the audio description
- When uncertain, classify as "noise" (fail-safe)`;
}

const VALID_CLASSIFICATIONS = new Set<string>(["speech", "music", "noise"]);

/** Parsed audio classification result */
export interface AudioClassificationResult {
  readonly classification: "speech" | "music" | "noise";
  readonly confidence: number;
  readonly rhythmRegularity: number;
  readonly harmonicContent: number;
  readonly speechCadence: number;
}

/**
 * Parse classification response. Fail-closed: returns noise on parse error.
 */
export function parseClassifyAudioResponse(raw: string): AudioClassificationResult {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const result = JSON.parse(cleaned);

    const classification = VALID_CLASSIFICATIONS.has(result.classification)
      ? (result.classification as "speech" | "music" | "noise")
      : "noise";

    const clamp = (v: unknown): number =>
      typeof v === "number" ? Math.max(0, Math.min(1, v)) : 0;

    return {
      classification,
      confidence: clamp(result.confidence),
      rhythmRegularity: clamp(result.rhythmRegularity),
      harmonicContent: clamp(result.harmonicContent),
      speechCadence: clamp(result.speechCadence),
    };
  } catch {
    logger.debug("Prompt parse failed — returning safe default", { raw: cleaned });
    return {
      classification: "noise",
      confidence: 0,
      rhythmRegularity: 0,
      harmonicContent: 0,
      speechCadence: 0,
    };
  }
}
