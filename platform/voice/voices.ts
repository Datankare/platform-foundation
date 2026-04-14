/**
 * platform/voice/voices.ts — Voice configuration registry
 *
 * Single source of truth for all voice configs: TTS voice names,
 * STT language codes, auto-detect pools.
 *
 * When adding a language:
 * 1. Add to platform/translation/languages.ts (language metadata)
 * 2. Add to this file (voice + STT codes)
 * 3. Both files stay in sync via the shared language code.
 *
 * @module platform/voice
 */

import type { VoiceConfig } from "./types";

// ── Voice Configurations ────────────────────────────────────────────────

export const VOICE_CONFIGS: readonly VoiceConfig[] = [
  {
    code: "en",
    languageCode: "en-US",
    voiceName: "en-US-Neural2-F",
    sttLanguageCode: "en-US",
  },
  {
    code: "es",
    languageCode: "es-ES",
    voiceName: "es-ES-Neural2-A",
    sttLanguageCode: "es-ES",
  },
  {
    code: "fr",
    languageCode: "fr-FR",
    voiceName: "fr-FR-Neural2-F",
    sttLanguageCode: "fr-FR",
  },
  {
    code: "hi",
    languageCode: "hi-IN",
    voiceName: "hi-IN-Neural2-A",
    sttLanguageCode: "hi-IN",
  },
  {
    code: "ar",
    languageCode: "ar-XA",
    voiceName: "ar-XA-Wavenet-A",
    sttLanguageCode: "ar-XA",
  },
  {
    code: "zh",
    languageCode: "cmn-CN",
    voiceName: "cmn-CN-Wavenet-A",
    sttLanguageCode: "cmn-CN",
  },
  {
    code: "bn",
    languageCode: "bn-IN",
    voiceName: "bn-IN-Wavenet-A",
    sttLanguageCode: "bn-IN",
  },
  {
    code: "kn",
    languageCode: "kn-IN",
    voiceName: "kn-IN-Wavenet-A",
    sttLanguageCode: "kn-IN",
  },
  {
    code: "ml",
    languageCode: "ml-IN",
    voiceName: "ml-IN-Wavenet-A",
    sttLanguageCode: "ml-IN",
  },
  {
    code: "te",
    languageCode: "te-IN",
    voiceName: "te-IN-Standard-A",
    sttLanguageCode: "te-IN",
  },
] as const;

// ── Lookup Helpers ──────────────────────────────────────────────────────

const configMap = new Map(VOICE_CONFIGS.map((v) => [v.code, v]));

/** Get voice config by language code, with English fallback */
export function getVoiceConfig(code: string): VoiceConfig {
  return configMap.get(code) ?? configMap.get("en")!;
}

/** All supported language codes for voice */
export const VOICE_SUPPORTED_CODES: readonly string[] = VOICE_CONFIGS.map((v) => v.code);

/** STT language codes for auto-detect pool (top 6 by usage) */
export const AUTO_DETECT_POOL: readonly string[] = [
  "en-US",
  "hi-IN",
  "es-ES",
  "fr-FR",
  "ar-XA",
  "cmn-CN",
];

/** Check if a language code has voice support */
export function hasVoiceSupport(code: string): boolean {
  return configMap.has(code);
}
