/**
 * platform/voice/song-id.ts — Public API of the song-id module (ADR-054 D2)
 *
 * Song identification: the provider contract and constants, ACRCloud and mock providers, the
 * active provider, its health probe and the SONG_IDENTIFY rate rule. The module shares
 * platform/voice/ with voice and audio-convert until Sprint 7S moves it; its files are listed in
 * platform/modules/manifest.json. The module definition is platform/voice/song-id-module.ts.
 *
 * @module platform/voice/song-id
 */

export {
  IDENTIFY_INTENT,
  MIN_CLIP_SECONDS,
  MAX_CLIP_SECONDS,
  IDENTIFY_RATE_LIMIT_PER_HOUR,
  SONG_IDENTIFY_RULE,
  type SongIdentificationProvider,
  type SongMatch,
  type IdentifyRequest,
  type IdentifyResult,
  type IdentifyCache,
} from "./identify-types";
export {
  ACRCloudIdentifier,
  getAcrCloudConfig,
  isAcrCloudConfigured,
  type AcrCloudConfig,
} from "./acrcloud-identify";
export { MockSongIdentifier } from "./mock-identify";
export { checkSongIdHealth, SongIdHealthProbeAdapter } from "./song-id-health";
export {
  getSongIdProvider,
  setSongIdProvider,
  resetSongIdProvider,
} from "./song-id-provider";
