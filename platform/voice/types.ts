/**
 * platform/voice/types.ts — Voice provider contracts
 *
 * GenAI Principles:
 *   P1  — All TTS/STT through provider, never direct API
 *   P7  — Provider abstraction: swap Google → Azure → Whisper via env var
 *   P9  — Observable: every method returns latency for instrumentation
 *   P11 — Graceful degradation: chunker handles oversized text
 *
 * @module platform/voice
 */

// ── Voice Configuration ─────────────────────────────────────────────────

export interface VoiceConfig {
  /** ISO 639-1 language code (e.g., "en", "es") */
  readonly code: string;
  /** Google-style language code (e.g., "en-US", "cmn-CN") */
  readonly languageCode: string;
  /** Voice model name (e.g., "en-US-Neural2-F") */
  readonly voiceName: string;
  /** Google STT language code (may differ from TTS) */
  readonly sttLanguageCode: string;
}

// ── TTS Types ───────────────────────────────────────────────────────────

export interface TTSRequest {
  /** Text to synthesize */
  readonly text: string;
  /** Target language code (e.g., "en", "es") */
  readonly languageCode: string;
  /** Audio encoding format */
  readonly encoding?: AudioEncoding;
  /** Speaking rate (0.5 - 2.0, default 0.95) */
  readonly speakingRate?: number;
  /** Pitch adjustment (-20.0 to 20.0, default 0) */
  readonly pitch?: number;
}

export interface TTSResult {
  /** Base64-encoded audio content */
  readonly audioContent: string;
  /** Audio encoding used */
  readonly encoding: AudioEncoding;
  /** Language code used */
  readonly languageCode: string;
  /** Number of chunks (1 if text was under limit) */
  readonly chunks: number;
  /** Total latency in ms */
  readonly latencyMs: number;
  /** Text byte size before chunking */
  readonly textBytes: number;
}

// ── STT Types ───────────────────────────────────────────────────────────

export type AudioEncoding =
  | "WEBM_OPUS"
  | "OGG_OPUS"
  | "MP3"
  | "WAV"
  | "FLAC"
  | "LINEAR16";

export interface STTRequest {
  /** Base64-encoded audio content */
  readonly audioBase64: string;
  /** Audio encoding format */
  readonly encoding?: AudioEncoding;
  /** Sample rate in Hz (default varies by encoding) */
  readonly sampleRateHertz?: number;
  /** Language code hint (used when autoDetect=false) */
  readonly languageCode?: string;
  /** Enable multi-language auto-detection */
  readonly autoDetect?: boolean;
}

export interface STTResult {
  /** Transcribed text */
  readonly transcript: string;
  /** Transcription confidence (0-1) */
  readonly confidence: number;
  /** Detected or specified language code */
  readonly languageCode: string;
  /** Transcription latency in ms */
  readonly latencyMs: number;
}

// ── Provider Interfaces ─────────────────────────────────────────────────

export interface TTSProvider {
  /** Provider name (e.g., "google", "azure", "mock") */
  readonly name: string;

  /**
   * Synthesize text to audio.
   * Handles chunking internally if text exceeds provider limits.
   */
  synthesize(request: TTSRequest): Promise<TTSResult>;

  /**
   * Get supported language codes for TTS.
   */
  getSupportedLanguages(): string[];
}

export interface STTProvider {
  /** Provider name (e.g., "google", "whisper", "mock") */
  readonly name: string;

  /**
   * Transcribe audio to text.
   */
  transcribe(request: STTRequest): Promise<STTResult>;

  /**
   * Get supported language codes for STT.
   */
  getSupportedLanguages(): string[];

  /**
   * Get supported audio encoding formats.
   */
  getSupportedEncodings(): AudioEncoding[];
}

// ── Voice Metrics (for MetricsSink) ─────────────────────────────────────

export interface VoiceMetrics {
  readonly provider: string;
  readonly operation: "tts" | "stt";
  readonly languageCode: string;
  readonly latencyMs: number;
  readonly textBytes?: number;
  readonly audioBytes?: number;
  readonly chunks?: number;
  readonly success: boolean;
  readonly error?: string;
}
