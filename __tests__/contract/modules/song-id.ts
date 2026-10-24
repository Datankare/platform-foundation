/**
 * __tests__/contract/modules/song-id.ts — The song-id module's conformance kits (ADR-027, ADR-054 D4)
 *
 * Keyed by the module's provider slot names, like the core manifest (../manifest.ts). Listed as
 * the module's `kitManifest` in platform/modules/manifest.json; the conformance-coverage test
 * composes it with the core manifest when the module is registered.
 */

import type { ConformanceEntry } from "../manifest";
import { runSongIdProviderContract } from "../song-id-provider-contract";

export const MODULE_CONFORMANCE: Readonly<Record<string, ConformanceEntry>> = {
  songId: { kind: "registry", kit: runSongIdProviderContract },
};
