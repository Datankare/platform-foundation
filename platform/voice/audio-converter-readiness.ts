/**
 * platform/voice/audio-converter-readiness.ts — Whether the deployment converts audio
 *
 * An audio converter that actually converts is the ffmpeg service with its URL and key; the
 * passthrough and mock converters accept only canonical audio. Features that take arbitrary
 * uploaded audio (song identification, audio upload for speech) are offered only when this holds
 * (ADR-050 D3), so they read it from here rather than each restating the settings (ADR-054: the
 * modules that need it declare the dependency on audio-convert).
 *
 * @module platform/voice/audio-convert
 */

/** The settings source a readiness check reads (process.env by default). */
export type AudioConverterEnv = Readonly<Record<string, string | undefined>>;

function isSet(env: AudioConverterEnv, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "";
}

/** True when AUDIO_CONVERTER=ffmpeg-service with AUDIO_CONVERTER_URL and AUDIO_CONVERTER_KEY. */
export function isAudioConverterReady(env: AudioConverterEnv = process.env): boolean {
  return (
    env.AUDIO_CONVERTER === "ffmpeg-service" &&
    isSet(env, "AUDIO_CONVERTER_URL") &&
    isSet(env, "AUDIO_CONVERTER_KEY")
  );
}

/** What the converter needs, for a feature's `needs` text. */
export const AUDIO_CONVERTER_NEEDS =
  "AUDIO_CONVERTER=ffmpeg-service with AUDIO_CONVERTER_URL / AUDIO_CONVERTER_KEY";
