/**
 * SongIdentificationProvider interface contract — mock arm.
 * Runs the synced conformance kit (ADR-027) against MockSongIdentifier,
 * covering both the match and the graceful no-match path.
 */

import { runSongIdProviderContract } from "./contract/song-id-provider-contract";
import { MockSongIdentifier } from "@/platform/voice/mock-identify";

describe("SongIdentificationProvider contract — mock provider", () => {
  runSongIdProviderContract({
    makeMatchingProvider: () => new MockSongIdentifier(),
    makeNoMatchProvider: () => {
      const m = new MockSongIdentifier();
      m.forceNoMatch = true;
      return m;
    },
    sampleAudio: Buffer.from("contract-fake-audio"),
    durationSeconds: 10,
  });
});
