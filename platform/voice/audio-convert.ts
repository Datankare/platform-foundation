/**
 * platform/voice/audio-convert.ts — Public API of the audio-convert module (ADR-054 D2)
 *
 * Audio format conversion: the canonical format, the converter contract, the ffmpeg service,
 * passthrough and mock converters, their health probe and readiness. The module shares
 * platform/voice/ with voice and song-id until Sprint 7S moves it; its files are listed in
 * platform/modules/manifest.json. The module definition is platform/voice/audio-convert-module.ts.
 *
 * @module platform/voice/audio-convert
 */

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
export { checkAudioConverterHealth } from "./audio-convert-health";
export {
  isAudioConverterReady,
  AUDIO_CONVERTER_NEEDS,
  type AudioConverterEnv,
} from "./audio-converter-readiness";
