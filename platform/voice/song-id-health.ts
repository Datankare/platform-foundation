/**
 * platform/voice/song-id-health.ts — Health probe for the song identification provider
 *
 * Moved from platform/voice/health-probe.ts when song identification became its own module
 * (ADR-054 D2). The probe is registered by the song-id module (song-id-module.ts), wrapping the
 * live provider and cached, because each check is a billable identify call (audit X-13).
 *
 * @module platform/voice/song-id
 */

import type { SongIdentificationProvider } from "./identify-types";
import type { HealthProbe, HealthCheckResult } from "@/platform/observability/types";
import {
  probeResponsive,
  type ProviderHealthStatus,
} from "@/platform/observability/provider-health";

/**
 * Check song identification provider health.
 * Sends a minimal audio buffer — expects either a result or a non-connectivity error.
 */
export async function checkSongIdHealth(
  provider: SongIdentificationProvider
): Promise<ProviderHealthStatus> {
  // Minimal WAV-like buffer — provider may return no match (healthy)
  // or throw a validation error (also healthy — means it's reachable)
  const minimalAudio = Buffer.alloc(160_000, 0); // ~5s at 32kB/s
  return probeResponsive(provider.name, () =>
    provider.identify({
      audioData: minimalAudio,
      durationSeconds: 5,
      requestId: "health-check",
    })
  );
}

/** Wraps checkSongIdHealth into the HealthProbe interface for HealthRegistry (TASK-041). */
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
