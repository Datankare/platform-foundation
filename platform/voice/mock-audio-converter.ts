/**
 * platform/voice/mock-audio-converter.ts — Mock audio format converter
 *
 * Deterministic mock for testing. Returns a small WAV-like buffer
 * without performing real conversion. Supports all source formats.
 *
 * GenAI Principles:
 *   P5  — estimatedCostUsd = 0
 *   P10 — Testable: deterministic, zero external dependencies
 *
 * @module platform/voice
 */

import type {
  AudioFormatConverter,
  ConversionRequest,
  ConversionResult,
  SourceAudioFormat,
} from "./audio-format-types";

// ── Mock canonical WAV header (44 bytes, 16kHz mono s16) ────────────────

const MOCK_WAV_HEADER = Buffer.from([
  0x52,
  0x49,
  0x46,
  0x46, // "RIFF"
  0x24,
  0x00,
  0x00,
  0x00, // ChunkSize (placeholder)
  0x57,
  0x41,
  0x56,
  0x45, // "WAVE"
  0x66,
  0x6d,
  0x74,
  0x20, // "fmt "
  0x10,
  0x00,
  0x00,
  0x00, // SubChunk1Size (16 for PCM)
  0x01,
  0x00, // AudioFormat (1 = PCM)
  0x01,
  0x00, // NumChannels (1 = mono)
  0x80,
  0x3e,
  0x00,
  0x00, // SampleRate (16000)
  0x00,
  0x7d,
  0x00,
  0x00, // ByteRate (32000)
  0x02,
  0x00, // BlockAlign (2)
  0x10,
  0x00, // BitsPerSample (16)
  0x64,
  0x61,
  0x74,
  0x61, // "data"
  0x00,
  0x00,
  0x00,
  0x00, // SubChunk2Size (placeholder)
]);

const ALL_FORMATS: SourceAudioFormat[] = ["webm", "mp3", "ogg", "flac", "wav", "opus"];

// ── Implementation ──────────────────────────────────────────────────────

export class MockAudioConverter implements AudioFormatConverter {
  readonly name = "mock";

  /** Track calls for test assertions */
  public convertCalls: ConversionRequest[] = [];

  /** If set, convert() will throw this error */
  public errorToThrow: Error | null = null;

  /** Simulated latency in ms */
  public simulatedLatencyMs = 0;

  async convert(request: ConversionRequest): Promise<ConversionResult> {
    this.convertCalls.push(request);

    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    if (this.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedLatencyMs));
    }

    const isAlreadyCanonical = request.sourceFormat === "wav";
    const outputData = isAlreadyCanonical
      ? request.audioData
      : Buffer.concat([MOCK_WAV_HEADER, Buffer.alloc(100)]);

    return {
      audioData: outputData,
      sourceFormat: request.sourceFormat,
      converted: !isAlreadyCanonical,
      latencyMs: this.simulatedLatencyMs,
      sourceSizeBytes: request.audioData.length,
      outputSizeBytes: outputData.length,
      estimatedCostUsd: 0,
    };
  }

  supportsFormat(format: SourceAudioFormat): boolean {
    return ALL_FORMATS.includes(format);
  }

  getSupportedFormats(): SourceAudioFormat[] {
    return [...ALL_FORMATS];
  }

  /** Reset call tracking and error state */
  reset(): void {
    this.convertCalls = [];
    this.errorToThrow = null;
    this.simulatedLatencyMs = 0;
  }
}
