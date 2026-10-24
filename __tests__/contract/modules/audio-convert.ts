/**
 * __tests__/contract/modules/audio-convert.ts — The audio-convert module's conformance kits (ADR-027, ADR-054 D4)
 *
 * Keyed by the module's provider slot names, like the core manifest (../manifest.ts). Listed as
 * the module's `kitManifest` in platform/modules/manifest.json; the conformance-coverage test
 * composes it with the core manifest when the module is registered.
 */

import type { ConformanceEntry } from "../manifest";
import { runAudioConverterContract } from "../audio-converter-contract";

export const MODULE_CONFORMANCE: Readonly<Record<string, ConformanceEntry>> = {
  audioConverter: { kind: "registry", kit: runAudioConverterContract },
};
