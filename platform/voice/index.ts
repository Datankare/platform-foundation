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
  checkSongIdHealth,
  checkAudioConverterHealth,
  type VoiceHealthStatus,
} from "./health-probe";

// Audio format conversion (Sprint 4a)
export {
  CANONICAL_FORMAT,
  type SourceAudioFormat,
  type ConversionRequest,
  type ConversionResult,
  type AudioFormatConverter,
} from "./audio-format-types";
export { FfmpegServiceConverter } from "./ffmpeg-converter";
export { PassthroughConverter } from "./passthrough-converter";
export { MockAudioConverter } from "./mock-audio-converter";

// Song identification (Sprint 4a)
export {
  IDENTIFY_INTENT,
  MIN_CLIP_SECONDS,
  MAX_CLIP_SECONDS,
  IDENTIFY_RATE_LIMIT_PER_HOUR,
  type SongIdentificationProvider,
  type SongMatch,
  type IdentifyRequest,
  type IdentifyResult,
  type IdentifyCache,
} from "./identify-types";
export { ACRCloudIdentifier } from "./acrcloud-identify";
export { MockSongIdentifier } from "./mock-identify";

// Providers
export { GoogleTTSProvider } from "./google-tts";
export { GoogleSTTProvider } from "./google-stt";
export { MockTTSProvider, MockSTTProvider } from "./mock-voice";
