/**
 * __tests__/contract/modules/voice.ts — The voice module's conformance kits (ADR-027, ADR-054 D4)
 *
 * Keyed by the module's provider slot names, like the core manifest (../manifest.ts). Listed as
 * the module's `kitManifest` in platform/modules/manifest.json; the conformance-coverage test
 * composes it with the core manifest when the module is registered.
 */

import type { ConformanceEntry } from "../manifest";
import { runTTSProviderContract } from "../tts-provider-contract";
import { runSTTProviderContract } from "../stt-provider-contract";

export const MODULE_CONFORMANCE: Readonly<Record<string, ConformanceEntry>> = {
  tts: { kind: "registry", kit: runTTSProviderContract },
  stt: { kind: "registry", kit: runSTTProviderContract },
};
