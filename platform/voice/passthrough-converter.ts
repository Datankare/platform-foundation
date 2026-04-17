/**
 * platform/voice/passthrough-converter.ts — Passthrough audio converter
 *
 * Optimization path: if audio is already WAV, passes through without
 * re-encoding. Non-authoritative — does NOT validate WAV header parameters.
 * Use FfmpegServiceConverter for guaranteed canonical format compliance.
 *
 * Use cases:
 *   - Development/testing without ffmpeg service dependency
 *   - Pre-converted audio from trusted sources
 *   - Reducing latency when source is known to be canonical
 *
 * GenAI Principles:
 *   P5  — estimatedCostUsd = 0 (no processing)
 *   P7  — Provider abstraction: swappable via AUDIO_CONVERTER env var
 *   P11 — Graceful degradation: works offline, no external dependency
 *
 * @module platform/voice
 */

import type {
  AudioFormatConverter,
  ConversionRequest,
  ConversionResult,
  SourceAudioFormat,
} from "./audio-format-types";

// ── Implementation ──────────────────────────────────────────────────────

export class PassthroughConverter implements AudioFormatConverter {
  readonly name = "passthrough";

  async convert(request: ConversionRequest): Promise<ConversionResult> {
    const start = Date.now();
    const { audioData, sourceFormat } = request;

    if (sourceFormat !== "wav") {
      throw new Error(
        `PassthroughConverter only accepts WAV input, got: ${sourceFormat}. ` +
          `Use ffmpeg-service converter for format conversion.`
      );
    }

    return {
      audioData,
      sourceFormat,
      converted: false,
      latencyMs: Date.now() - start,
      sourceSizeBytes: audioData.length,
      outputSizeBytes: audioData.length,
      estimatedCostUsd: 0,
    };
  }

  supportsFormat(format: SourceAudioFormat): boolean {
    return format === "wav";
  }

  getSupportedFormats(): SourceAudioFormat[] {
    return ["wav"];
  }
}
