/**
 * platform/voice/index.ts — Public API of the voice module (ADR-054 D2)
 *
 * Text-to-speech, speech-to-text, the voice pipeline, chunker and voices. Song identification
 * and audio conversion are their own modules with their own entries — platform/voice/song-id.ts
 * and platform/voice/audio-convert.ts — and share this directory only until Sprint 7S. The
 * module definition is ./voice-module.ts.
 *
 * @module platform/voice
 */

// Types
export type {
  TTSProvider,
  STTProvider,
  TTSRequest,
  TTSResult,
  STTRequest,
  STTResult,
  AudioEncoding,
  VoiceConfig,
  VoiceMetrics,
} from "./types";

// Voice configurations
export {
  VOICE_CONFIGS,
  VOICE_SUPPORTED_CODES,
  AUTO_DETECT_POOL,
  getVoiceConfig,
  hasVoiceSupport,
} from "./voices";

// Chunker
export { chunkText, getByteLength, TTS_BYTE_LIMIT } from "./chunker";

// Pipeline
export {
  VoicePipeline,
  type PipelineRequest,
  type PipelineResult,
  type PipelineStepResult,
  type PipelineConfig,
  type PipelineMetricEvent,
  type PipelineIntent,
  type SafetyScreenFn,
  type TranslationCache,
} from "./pipeline";

// Health probes
export {
  checkTranslationHealth,
  checkTTSHealth,
  checkSTTHealth,
  type VoiceHealthStatus,
} from "./health-probe";

// Providers
export { GoogleTTSProvider } from "./google-tts";
export { GoogleSTTProvider } from "./google-stt";
export { MockTTSProvider, MockSTTProvider } from "./mock-voice";
