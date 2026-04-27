/**
 * platform/voice/health-probe.ts — Health probes for voice + translation
 *
 * Registers probes in HealthRegistry for:
 * - Translation provider (connectivity + latency)
 * - TTS provider (connectivity + latency)
 * - STT provider (connectivity)
 * - Song identification provider (connectivity) — Sprint 4a
 * - Audio format converter (connectivity) — Sprint 4a
 *
 * @module platform/voice
 */

import type { TTSProvider, STTProvider } from "./types";
import type { TranslationProvider } from "@/platform/translation/types";
import type { SongIdentificationProvider } from "./identify-types";
import type { AudioFormatConverter } from "./audio-format-types";

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

/**
 * Check song identification provider health.
 * Sends a minimal audio buffer — expects either a result or a non-connectivity error.
 */
export async function checkSongIdHealth(
  provider: SongIdentificationProvider
): Promise<VoiceHealthStatus> {
  const start = Date.now();
  try {
    // Minimal WAV-like buffer — provider may return no match (healthy)
    // or throw a validation error (also healthy — means it's reachable)
    const minimalAudio = Buffer.alloc(160_000, 0); // ~5s at 32kB/s
    await provider.identify({
      audioData: minimalAudio,
      durationSeconds: 5,
      requestId: "health-check",
    });
    return {
      provider: provider.name,
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
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

/**
 * Check audio format converter health.
 * Sends a minimal WAV buffer — expects passthrough or conversion success.
 */
export async function checkAudioConverterHealth(
  converter: AudioFormatConverter
): Promise<VoiceHealthStatus> {
  const start = Date.now();
  try {
    const minimalWav = Buffer.alloc(100, 0);
    await converter.convert({
      audioData: minimalWav,
      sourceFormat: "wav",
      requestId: "health-check",
    });
    return {
      provider: converter.name,
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isConnectivity = /ECONNREFUSED|ENOTFOUND|timed out|fetch failed/i.test(message);

    return {
      provider: converter.name,
      healthy: !isConnectivity,
      latencyMs: Date.now() - start,
      error: isConnectivity ? message : undefined,
    };
  }
}

// ── HealthProbe Adapter (TASK-041) ──────────────────────────────────────────
// Wraps checkSongIdHealth into HealthProbe interface for HealthRegistry.

import type { HealthProbe, HealthCheckResult } from "@/platform/observability/types";

export class SongIdHealthProbeAdapter implements HealthProbe {
  readonly name = "song-identification";
  private readonly provider: SongIdentificationProvider;

  constructor(provider: SongIdentificationProvider) {
    this.provider = provider;
  }

  async check(): Promise<HealthCheckResult> {
    const result = await checkSongIdHealth(this.provider);
    return {
      name: this.name,
      status: result.healthy ? "healthy" : "unhealthy",
      latencyMs: result.latencyMs,
      detail: result.error,
      checkedAt: new Date().toISOString(),
    };
  }
}
