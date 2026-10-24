/**
 * platform/voice/audio-convert-health.ts — Health probe for the audio format converter
 *
 * Moved from platform/voice/health-probe.ts when audio conversion became its own module
 * (ADR-054 D2).
 *
 * @module platform/voice/audio-convert
 */

import type { AudioFormatConverter } from "./audio-format-types";
import {
  probeResponsive,
  type ProviderHealthStatus,
} from "@/platform/observability/provider-health";

/**
 * Check audio format converter health.
 * Sends a minimal WAV buffer — expects passthrough or conversion success.
 */
export async function checkAudioConverterHealth(
  converter: AudioFormatConverter
): Promise<ProviderHealthStatus> {
  const minimalWav = Buffer.alloc(100, 0);
  return probeResponsive(converter.name, () =>
    converter.convert({
      audioData: minimalWav,
      sourceFormat: "wav",
      requestId: "health-check",
    })
  );
}
