/**
 * platform/voice/index.ts — Public API
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
