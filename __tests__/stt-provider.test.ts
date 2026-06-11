/**
 * STTProvider interface contract — mock arm.
 * Runs the synced conformance kit (ADR-027) against MockSTTProvider.
 */

import { runSTTProviderContract } from "./contract/stt-provider-contract";
import { MockSTTProvider } from "@/platform/voice/mock-voice";

describe("STTProvider contract — mock provider", () => {
  runSTTProviderContract({
    makeProvider: () => new MockSTTProvider(),
    sampleAudioBase64: Buffer.from("hello world").toString("base64"),
  });
});
