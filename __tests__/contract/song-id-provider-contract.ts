/**
 * __tests__/contract/song-id-provider-contract.ts
 *
 * SongIdentificationProvider conformance kit (TCK) — ADR-027.
 *
 * The no-match path (match=null, not an error) is a contract behavior
 * (P11). The mock elicits it via forceNoMatch; a real ACRCloud arm elicits
 * it via a stubbed miss. The kit therefore takes separate match / no-match
 * factories rather than a single provider.
 *
 * Not a *.test.ts. GenAI principles: P1, P5, P10, P11, P17, P18.
 */

import type { SongIdentificationProvider } from "@/platform/voice/identify-types";

export interface SongIdContractFixtures {
  makeMatchingProvider: () =>
    | SongIdentificationProvider
    | Promise<SongIdentificationProvider>;
  makeNoMatchProvider: () =>
    | SongIdentificationProvider
    | Promise<SongIdentificationProvider>;
  /** Impl-specific: audio the implementation accepts (canonical WAV bytes). */
  sampleAudio: Buffer;
  durationSeconds: number;
}

export function runSongIdProviderContract(fx: SongIdContractFixtures): void {
  describe("identify — match path", () => {
    it("returns a structured match with contract-conformant fields", async () => {
      const provider = await fx.makeMatchingProvider();
      const r = await provider.identify({
        audioData: fx.sampleAudio,
        durationSeconds: fx.durationSeconds,
        requestId: "contract-req-1",
      });
      expect(r.matched).toBe(true);
      expect(r.match).not.toBeNull();
      expect(typeof r.match!.title).toBe("string");
      expect(r.match!.title.length).toBeGreaterThan(0);
      expect(typeof r.match!.artist).toBe("string");
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
      expect(r.provider).toBe(provider.name);
      expect(typeof r.requestId).toBe("string");
      expect(r.requestId.length).toBeGreaterThan(0);
      expect(r.clipDurationSeconds).toBe(fx.durationSeconds);
      expect(typeof r.estimatedCostUsd).toBe("number");
      expect(r.estimatedCostUsd).toBeGreaterThanOrEqual(0);
      expect(r.intent).toBe("inform");
    });

    it("passes trajectory context through to the result", async () => {
      const provider = await fx.makeMatchingProvider();
      const r = await provider.identify({
        audioData: fx.sampleAudio,
        durationSeconds: fx.durationSeconds,
        trajectoryId: "traj-42",
        stepIndex: 7,
      });
      expect(r.trajectoryId).toBe("traj-42");
      expect(r.stepIndex).toBe(7);
    });
  });

  describe("identify — no-match path", () => {
    it("returns match=null without throwing (graceful degradation)", async () => {
      const provider = await fx.makeNoMatchProvider();
      const r = await provider.identify({
        audioData: fx.sampleAudio,
        durationSeconds: fx.durationSeconds,
      });
      expect(r.matched).toBe(false);
      expect(r.match).toBeNull();
      expect(r.provider).toBe(provider.name);
      expect(r.intent).toBe("inform");
    });
  });
}
