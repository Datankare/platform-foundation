/**
 * platform/voice/health-probe.ts — Health probes for voice + translation
 *
 * Registers probes in HealthRegistry for:
 * - Translation provider (connectivity + latency)
 * - TTS provider (connectivity + latency)
 * - STT provider (connectivity)
 *
 * @module platform/voice
 */

import type { TTSProvider, STTProvider } from "./types";
import type { TranslationProvider } from "@/platform/translation/types";

// ── Health Probe Results ────────────────────────────────────────────────

export interface VoiceHealthStatus {
  readonly provider: string;
  readonly healthy: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

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
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check STT provider health (lightweight — just verifies provider is responsive).
 * Sends a tiny silent audio clip.
 */
export async function checkSTTHealth(provider: STTProvider): Promise<VoiceHealthStatus> {
  const start = Date.now();
  try {
    // Minimal valid base64 audio (silence)
    const silentAudio = Buffer.from([0, 0, 0, 0]).toString("base64");
    await provider.transcribe({
      audioBase64: silentAudio,
      encoding: "LINEAR16",
      sampleRateHertz: 8000,
      languageCode: "en-US",
      autoDetect: false,
    });
    return {
      provider: provider.name,
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    // STT may return an error for silent audio — that's still "responsive"
    const message = err instanceof Error ? err.message : String(err);
    const isConnectivity = /ECONNREFUSED|ENOTFOUND|timed out|fetch failed/i.test(message);

    return {
      provider: provider.name,
      healthy: !isConnectivity,
      latencyMs: Date.now() - start,
      error: isConnectivity ? message : undefined,
    };
  }
}
