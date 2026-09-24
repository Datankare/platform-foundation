/**
 * __tests__/contract/provenance-contract.ts — ADR-047 L21 provenance/detection kit.
 *
 * The contract for synthetic-media identity: an emitted credential is verifiable, tampering
 * (image or claim) breaks verification, and detection yields a risk signal — never a gate.
 */
import type { ImageBytes, ProvenanceCredential, DetectionSignal } from "@/platform/ai";

export interface ProvenanceHarness {
  readonly name: string;
  readonly emit: (image: ImageBytes, model: string) => ProvenanceCredential;
  readonly verify: (credential: ProvenanceCredential, image: ImageBytes) => boolean;
  readonly detect: (content: ImageBytes) => Promise<DetectionSignal>;
}

export function runProvenanceContract(h: ProvenanceHarness): void {
  const IMG: ImageBytes = { mediaType: "image/png", data: "aGVsbG8=" };
  describe(`provenance contract — ${h.name} (ADR-047 L21)`, () => {
    it("a committed image's credential verifies", () => {
      expect(h.verify(h.emit(IMG, "m"), IMG)).toBe(true);
    });
    it("a tampered image fails verification", () => {
      expect(h.verify(h.emit(IMG, "m"), { ...IMG, data: "b3RoZXI=" })).toBe(false);
    });
    it("a tampered claim fails verification", () => {
      const c = h.emit(IMG, "m");
      expect(h.verify({ ...c, model: "forged" }, IMG)).toBe(false);
    });
    it("detection yields a signal, not a gate (returns, never throws/blocks)", async () => {
      const s = await h.detect(IMG);
      expect(typeof s.synthetic).toBe("boolean");
      expect(typeof s.confidence).toBe("number");
    });
  });
}
