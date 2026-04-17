/**
 * platform/voice/audio-format-types.ts — Audio format conversion contracts
 *
 * Defines the canonical audio format for the platform and the converter
 * interface for normalizing arbitrary audio inputs.
 *
 * Platform Decision: ALL audio entering the platform is normalized to
 * WAV 16kHz mono 16-bit PCM. This strips container metadata (privacy P12)
 * and ensures consistent input to all downstream providers (STT, song ID).
 *
 * GenAI Principles:
 *   P1  — All conversion through AudioFormatConverter, never direct ffmpeg
 *   P3  — Canonical conversion strips metadata (privacy by design)
 *   P5  — estimatedCostUsd in every ConversionResult
 *   P7  — Provider abstraction: swap ffmpeg-service → browser → wasm via env
 *   P9  — Every conversion returns latencyMs for instrumentation
 *   P10 — MockAudioConverter for tests
 *   P12 — Metadata stripping during canonical conversion
 *
 * @module platform/voice
 */

// ── Canonical Format ────────────────────────────────────────────────────

/**
 * Platform canonical audio format.
 * All audio is normalized to this format before processing.
 */
export const CANONICAL_FORMAT = {
  /** Container format */
  format: "wav",
  /** Sample rate in Hz */
  sampleRate: 16000,
  /** Number of channels */
  channels: 1,
  /** Bits per sample */
  bitDepth: 16,
  /** PCM encoding */
  encoding: "s16le",
  /** MIME type */
  mimeType: "audio/wav",
} as const;

/**
 * Supported source formats for conversion.
 */
export type SourceAudioFormat = "webm" | "mp3" | "ogg" | "flac" | "wav" | "opus";

// ── Conversion Types ────────────────────────────────────────────────────

export interface ConversionRequest {
  /** Raw audio bytes as Buffer */
  readonly audioData: Buffer;
  /** Source format hint (required for correct decoding) */
  readonly sourceFormat: SourceAudioFormat;
  /** Request ID for tracing (P9) */
  readonly requestId?: string;
}

export interface ConversionResult {
  /** Converted audio in canonical format (WAV 16kHz mono s16) */
  readonly audioData: Buffer;
  /** Source format that was converted from */
  readonly sourceFormat: SourceAudioFormat;
  /** Whether the audio was actually converted (false = already canonical) */
  readonly converted: boolean;
  /** Conversion latency in ms */
  readonly latencyMs: number;
  /** Source audio size in bytes */
  readonly sourceSizeBytes: number;
  /** Output audio size in bytes */
  readonly outputSizeBytes: number;
  /** Estimated cost in USD for this conversion (P5) */
  readonly estimatedCostUsd: number;
}

// ── Provider Interface ──────────────────────────────────────────────────

export interface AudioFormatConverter {
  /** Provider name (e.g., "ffmpeg-service", "passthrough", "mock") */
  readonly name: string;

  /**
   * Convert audio to canonical platform format.
   * Strips all container metadata during conversion (P3/P12).
   *
   * @throws Error if conversion fails (422) or audio exceeds size limit (413)
   */
  convert(request: ConversionRequest): Promise<ConversionResult>;

  /**
   * Check if a source format is supported for conversion.
   */
  supportsFormat(format: SourceAudioFormat): boolean;

  /**
   * Get the list of supported source formats.
   */
  getSupportedFormats(): SourceAudioFormat[];
}
