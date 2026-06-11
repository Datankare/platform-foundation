/**
 * TTSProvider interface contract — mock arm.
 * Runs the synced conformance kit (ADR-027) against MockTTSProvider.
 */

import { runTTSProviderContract } from "./contract/tts-provider-contract";
import { MockTTSProvider } from "@/platform/voice/mock-voice";

describe("TTSProvider contract — mock provider", () => {
  runTTSProviderContract({
    makeProvider: () => new MockTTSProvider(),
  });
});
