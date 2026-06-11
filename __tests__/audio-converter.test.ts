/**
 * AudioFormatConverter interface contract — reference arm (ADR-027).
 */
import { runAudioConverterContract } from "./contract/audio-converter-contract";
import { MockAudioConverter } from "@/platform/voice/mock-audio-converter";

describe("AudioFormatConverter contract — mock converter", () => {
  runAudioConverterContract({
    makeConverter: () => new MockAudioConverter(),
  });
});
