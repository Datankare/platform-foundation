/**
 * platform/voice/voice-module.ts — The voice module (ADR-019, ADR-054 D2)
 *
 * Text-to-speech, speech-to-text, the voice pipeline, chunker and voices: the TTS and STT slots,
 * the speech goals, the "transcribe" consent and account-status feature, the "transcription"
 * moderation content type and the speech features. Shares platform/voice/ with song-id and
 * audio-convert until Sprint 7S; its files are listed in platform/modules/manifest.json.
 *
 * Depends on translation (the pipeline's translate step takes a TranslationProvider) and on
 * audio-convert (uploaded audio is offered only with a converter that converts).
 *
 * @module platform/voice
 */

import { definePlatformModule } from "@/platform/modules/define";
import type { ModuleProviderSlot } from "@/platform/modules/types";
import type { EnvSource } from "@/platform/providers/environment-contract";
import { getGoogleApiKeySetting } from "@/shared/config/apiKeys";
import {
  AUDIO_CONVERTER_NEEDS,
  isAudioConverterReady,
} from "./audio-converter-readiness";

/** A speech key is configured (GOOGLE_API_KEY, ignoring blanks; never a NEXT_PUBLIC_ one, G-13). */
function googleSpeechReady(env: EnvSource): boolean {
  const v = env.GOOGLE_API_KEY;
  return typeof v === "string" && v.trim() !== "";
}

/** A Google slot that reports a missing key at boot (the provider is built where it is used). */
function googleSlot(
  slot: string,
  envVar: string,
  consequence: string
): ModuleProviderSlot {
  return {
    slot,
    envVar,
    values: ["google", "mock"],
    defaultValue: "mock",
    singletonKeys: [],
    init: (selection, { env, warn }) => {
      if (selection === "google" && !getGoogleApiKeySetting(env)) {
        warn(`${envVar}=google but GOOGLE_API_KEY missing — ${consequence}`);
      }
    },
  };
}

export const VOICE_MODULE = definePlatformModule({
  id: "voice",
  dependsOn: ["translation", "audio-convert"],
  providers: [
    googleSlot("tts", "TTS_PROVIDER", "TTS will fail"),
    googleSlot("stt", "STT_PROVIDER", "STT will fail"),
  ],
  goals: ["transcribe", "speak", "translate-and-speak", "full-pipeline"],
  consentFeatures: ["transcribe"],
  accountStatusFeatures: ["transcribe"],
  // Transcribed speech (STT artifacts): severity may be reduced
  // (moderation.transcription_severity_reduction).
  moderationContentTypes: [{ name: "transcription", severityReduction: true }],
  features: [
    {
      id: "audio_upload",
      needs: `a speech key (GOOGLE_API_KEY) and ${AUDIO_CONVERTER_NEEDS} (uploaded files need converting)`,
      check: (env) => ({
        available: googleSpeechReady(env) && isAudioConverterReady(env),
      }),
    },
    {
      id: "speech_input",
      needs: "a speech key (GOOGLE_API_KEY)",
      check: (env) => ({ available: googleSpeechReady(env) }),
    },
  ],
  kits: [
    "__tests__/contract/tts-provider-contract.ts",
    "__tests__/contract/stt-provider-contract.ts",
  ],
});
