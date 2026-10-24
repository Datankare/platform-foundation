/**
 * platform/voice/song-id-provider.ts — The active song identification provider (TASK-041)
 *
 * The song-id module's provider slot (SONG_ID_PROVIDER, platform/voice/song-id-module.ts)
 * constructs the provider once and stores it here, mirroring the moderation/social store
 * pattern. The health probe wraps THIS instance — the one actually serving traffic — rather than
 * constructing a duplicate.
 *
 * @module platform/voice/song-id
 */

import type { SongIdentificationProvider } from "./identify-types";
import { MockSongIdentifier } from "./mock-identify";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
export const SONGIDPROVIDER_KEY = "platform.voice.songIdProvider";

function readCurrentSongIdProvider(): SongIdentificationProvider {
  return getSingleton<SongIdentificationProvider>(
    SONGIDPROVIDER_KEY,
    () => new MockSongIdentifier()
  );
}

function writeCurrentSongIdProvider(next: SongIdentificationProvider): void {
  setSingleton<SongIdentificationProvider>(SONGIDPROVIDER_KEY, next);
}

/** Set the active song identification provider (called by the song-id provider slot). */
export function setSongIdProvider(provider: SongIdentificationProvider): void {
  writeCurrentSongIdProvider(provider);
}

/** Get the active song identification provider. */
export function getSongIdProvider(): SongIdentificationProvider {
  return readCurrentSongIdProvider();
}

/** Reset to the mock provider (testing only). */
export function resetSongIdProvider(): void {
  writeCurrentSongIdProvider(new MockSongIdentifier());
}
