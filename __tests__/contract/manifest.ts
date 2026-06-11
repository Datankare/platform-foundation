/**
 * __tests__/contract/manifest.ts — Provider conformance manifest (ADR-027)
 *
 * Single source of truth mapping each platform abstraction to its conformance
 * kit. Registry entries are keyed by their ProviderSelections slot name (see
 * platform/providers/registry.ts); fabric entries (observability) are keyed by
 * interface name.
 *
 * The conformance-coverage meta-test walks the live provider registry and
 * fails if any registry slot is missing here — so a new provider cannot land
 * without a kit. Importing each runner by value means a removed kit is a
 * compile error, not a silent gap.
 */

import { runAuthProviderContract } from "./auth-provider-contract";
import { runCacheProviderContract } from "./cache-provider-contract";
import { runAIProviderContract } from "./ai-provider-contract";
import { runErrorReporterContract } from "./error-reporter-contract";
import { runRealtimeProviderContract } from "./realtime-provider-contract";
import { runTranslationProviderContract } from "./translation-provider-contract";
import { runTTSProviderContract } from "./tts-provider-contract";
import { runSTTProviderContract } from "./stt-provider-contract";
import { runSongIdProviderContract } from "./song-id-provider-contract";
import { runAudioConverterContract } from "./audio-converter-contract";
import { runModerationStoreContract } from "./moderation-store-contract";
import { runSocialStoreContract } from "./social-store-contract";
import { runEmbeddingProviderContract } from "./embedding-provider-contract";
import { runTraceProviderContract } from "./trace-provider-contract";
import { runMetricsSinkContract } from "./metrics-sink-contract";
import { runHealthProbeContract } from "./health-probe-contract";

export type ContractKind = "registry" | "fabric";

export interface ConformanceEntry {
  /** "registry" = a ProviderSelections slot (meta-test enforced); "fabric" = observability abstraction. */
  readonly kind: ContractKind;
  /**
   * The kit runner function. Type-erased to unknown because each kit has its
   * own fixtures signature; the meta-test only asserts presence + callability.
   * The value import above is the compile-time guarantee that it exists.
   */
  readonly kit: unknown;
}

/**
 * Keyed by ProviderSelections slot name for registry entries. If you add a
 * provider slot to platform/providers/registry.ts, add its kit here or the
 * conformance-coverage meta-test fails.
 */
export const CONFORMANCE_MANIFEST: Readonly<Record<string, ConformanceEntry>> = {
  // ── Registry slots (ProviderSelections keys) ──
  auth: { kind: "registry", kit: runAuthProviderContract },
  cache: { kind: "registry", kit: runCacheProviderContract },
  ai: { kind: "registry", kit: runAIProviderContract },
  errorReporter: { kind: "registry", kit: runErrorReporterContract },
  realtime: { kind: "registry", kit: runRealtimeProviderContract },
  translation: { kind: "registry", kit: runTranslationProviderContract },
  tts: { kind: "registry", kit: runTTSProviderContract },
  stt: { kind: "registry", kit: runSTTProviderContract },
  songId: { kind: "registry", kit: runSongIdProviderContract },
  audioConverter: { kind: "registry", kit: runAudioConverterContract },
  moderationStore: { kind: "registry", kit: runModerationStoreContract },
  socialStore: { kind: "registry", kit: runSocialStoreContract },
  embeddingProvider: { kind: "registry", kit: runEmbeddingProviderContract },

  // ── Observability fabric (not registry slots; folded in by ADR-027) ──
  traceProvider: { kind: "fabric", kit: runTraceProviderContract },
  metricsSink: { kind: "fabric", kit: runMetricsSinkContract },
  healthProbe: { kind: "fabric", kit: runHealthProbeContract },
};
