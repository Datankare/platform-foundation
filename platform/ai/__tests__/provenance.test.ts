/**
 * provenance.test.ts — provenance emit/verify + synthetic detection (ADR-047).
 */
import {
  emitProvenance,
  verifyProvenance,
  detectSyntheticOrigin,
  setSyntheticDetector,
  resetSyntheticDetector,
} from "../provenance";

const IMG = { mediaType: "image/png", data: "aGVsbG8=" };
afterEach(() => resetSyntheticDetector());

describe("provenance emit / verify", () => {
  it("emits a C2PA-shaped credential with a content hash and signature", () => {
    const c = emitProvenance(IMG, { model: "gen-v1" });
    expect(c.standard).toBe("c2pa");
    expect(c.model).toBe("gen-v1");
    expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a credential against its own image", () => {
    const c = emitProvenance(IMG, { model: "gen-v1" });
    expect(verifyProvenance(c, IMG)).toBe(true);
  });

  it("fails verification when the image is altered", () => {
    const c = emitProvenance(IMG, { model: "gen-v1" });
    expect(verifyProvenance(c, { ...IMG, data: "dGFtcGVy" })).toBe(false);
  });

  it("fails verification when the claim is altered", () => {
    const c = emitProvenance(IMG, { model: "gen-v1" });
    expect(verifyProvenance({ ...c, model: "forged" }, IMG)).toBe(false);
  });
});

describe("synthetic-origin detection", () => {
  it("returns a conservative signal by default", async () => {
    expect(await detectSyntheticOrigin(IMG)).toEqual({ synthetic: false, confidence: 0 });
  });

  it("returns the injected detector's signal (a signal, not a gate)", async () => {
    setSyntheticDetector(async () => ({ synthetic: true, confidence: 0.9 }));
    const s = await detectSyntheticOrigin(IMG);
    expect(s.synthetic).toBe(true);
    expect(s.confidence).toBeCloseTo(0.9);
  });
});
