/**
 * platform/voice/health-probe.ts — Health probes for the voice pipeline's providers
 *
 * - Translation provider (connectivity + latency) — the pipeline's translate step
 * - TTS provider (connectivity + latency)
 * - STT provider (connectivity)
 *
 * The song identification and audio converter probes belong to their own modules
 * (song-id-health.ts, audio-convert-health.ts — ADR-054 D2).
 *
 * @module platform/voice
 */

import type { TTSProvider, STTProvider } from "./types";
import type { TranslationProvider } from "@/platform/translation/types";
import {
  errorMessage,
  probeResponsive,
  type ProviderHealthStatus,
} from "@/platform/observability/provider-health";

// ── Health Probe Results ────────────────────────────────────────────────

/** One voice provider probe's outcome (the core provider-probe shape). */
export type VoiceHealthStatus = ProviderHealthStatus;

/**
 * Check translation provider health by translating a known phrase.
 */
export async function checkTranslationHealth(
  provider: TranslationProvider
): Promise<VoiceHealthStatus> {
  const start = Date.now();
  try {
    const result = await provider.translate("health check", "es", "en");
    return {
      provider: provider.name,
      healthy: result.text.length > 0,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      provider: provider.name,
      healthy: false,
      latencyMs: Date.now() - start,
      error: errorMessage(err),
    };
  }
}

/**
 * Check TTS provider health by synthesizing a short phrase.
 */
export async function checkTTSHealth(provider: TTSProvider): Promise<VoiceHealthStatus> {
  const start = Date.now();
  try {
    const result = await provider.synthesize({
      text: "health check",
      languageCode: "en",
    });
    return {
      provider: provider.name,
      healthy: result.audioContent.length > 0,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      provider: provider.name,
      healthy: false,
      latencyMs: Date.now() - start,
      error: errorMessage(err),
    };
  }
}

/**
 * Check STT provider health (lightweight — just verifies provider is responsive).
 * Sends a tiny silent audio clip; an error for silent audio still means the provider answered.
 */
export async function checkSTTHealth(provider: STTProvider): Promise<VoiceHealthStatus> {
  // Minimal valid base64 audio (silence)
  const silentAudio = Buffer.from([0, 0, 0, 0]).toString("base64");
  return probeResponsive(provider.name, () =>
    provider.transcribe({
      audioBase64: silentAudio,
      encoding: "LINEAR16",
      sampleRateHertz: 8000,
      languageCode: "en-US",
      autoDetect: false,
    })
  );
}
