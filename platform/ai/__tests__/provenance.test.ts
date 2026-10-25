/**
 * provenance.test.ts — provenance emit/verify + synthetic detection (ADR-047; audit X-18).
 */
import { createHash, createHmac } from "node:crypto";
import fc from "fast-check";
import { fuzzParams } from "@/__tests__/helpers/fuzz";
import {
  emitProvenance,
  verifyProvenance,
  detectSyntheticOrigin,
  setSyntheticDetector,
  resetSyntheticDetector,
  provenanceKeyId,
  type ProvenanceCredential,
} from "../provenance";

fc.configureGlobal(fuzzParams());

const KEY = "provenance-unit-test-key-0123456789abcdef";
const IMG = { mediaType: "image/png", data: "aGVsbG8=" };
beforeEach(() => {
  process.env.PROVENANCE_SIGNING_KEY = KEY;
});
afterEach(() => {
  delete process.env.PROVENANCE_SIGNING_KEY;
  resetSyntheticDetector();
});

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

describe("forgery (audit X-18: the signature was an unkeyed hash)", () => {
  const forgeUnkeyed = (claim: Omit<ProvenanceCredential, "signature">) => ({
    ...claim,
    signature: createHash("sha256").update(JSON.stringify(claim)).digest("hex"),
  });

  it("refuses a credential re-signed the old, unkeyed way", () => {
    const { signature: _s, ...claim } = emitProvenance(IMG, { model: "gen-v1" });
    expect(verifyProvenance(forgeUnkeyed({ ...claim, model: "forged" }), IMG)).toBe(
      false
    );
    expect(verifyProvenance(forgeUnkeyed(claim), IMG)).toBe(false);
  });

  it("refuses a credential signed with another key", () => {
    const c = emitProvenance(IMG, { model: "gen-v1" });
    process.env.PROVENANCE_SIGNING_KEY = "another-deployment-key-0123456789abcdef";
    expect(verifyProvenance(c, IMG)).toBe(false);
  });

  it("emits an unsigned credential without a key, and nothing verifies without one", () => {
    const signed = emitProvenance(IMG, { model: "gen-v1" });
    delete process.env.PROVENANCE_SIGNING_KEY;
    const unsigned = emitProvenance(IMG, { model: "gen-v1" });
    expect(unsigned.signature).toBe("");
    expect(verifyProvenance(unsigned, IMG)).toBe(false);
    expect(verifyProvenance(signed, IMG)).toBe(false);
  });

  it.each([
    ["an empty signature", { signature: "" }],
    ["a short signature", { signature: "ab" }],
    ["a non-hex signature", { signature: "z".repeat(64) }],
    ["an upper-case signature", { signature: "A".repeat(64) }],
    ["another standard", { standard: "jpeg-trust" }],
    ["a missing model", { model: undefined }],
    ["a numeric createdAt", { createdAt: 0 }],
  ])("refuses %s", (_label, over) => {
    const c = { ...emitProvenance(IMG, { model: "gen-v1" }), ...over };
    expect(verifyProvenance(c as unknown as ProvenanceCredential, IMG)).toBe(false);
  });

  it("refuses something that is not a credential", () => {
    for (const bad of [null, undefined, "c2pa", 1, []]) {
      expect(verifyProvenance(bad as unknown as ProvenanceCredential, IMG)).toBe(false);
    }
  });

  it("a signature over different field boundaries does not verify (canonical form)", () => {
    const c = emitProvenance(IMG, { model: "a", issuer: "b|c" });
    expect(verifyProvenance({ ...c, model: "a|b", issuer: "c" }, IMG)).toBe(false);
  });

  it("property: any change to a signed claim fails verification", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("issuer", "model", "createdAt"),
        fc.string({ minLength: 1, maxLength: 40 }),
        (field, value) => {
          const c = emitProvenance(IMG, { model: "gen-v1" });
          fc.pre(c[field] !== value);
          return verifyProvenance({ ...c, [field]: value }, IMG) === false;
        }
      )
    );
  });

  it("property: a signature an attacker computes without the key never verifies", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 64 }), (guess) => {
        fc.pre(guess !== KEY);
        const { signature: _s, ...claim } = emitProvenance(IMG, { model: "x" });
        const forged = {
          ...claim,
          model: "forged",
          signature: createHmac("sha256", guess)
            .update(
              JSON.stringify([
                claim.standard,
                claim.issuer,
                "forged",
                claim.createdAt,
                claim.contentHash,
              ])
            )
            .digest("hex"),
        };
        return verifyProvenance(forged, IMG) === false;
      })
    );
  });
});

describe("key rotation, unambiguous encoding, media types (review 7 L6)", () => {
  const OLD = "provenance-old-key-0123456789abcdef-old";
  afterEach(() => {
    delete process.env.PROVENANCE_SIGNING_KEY_PREVIOUS;
  });

  it("names the key that signed it by a fingerprint, never the key", () => {
    const c = emitProvenance(IMG, { model: "m" });
    expect(c.keyId).toBe(provenanceKeyId(KEY));
    expect(c.keyId).toMatch(/^k-[0-9a-f]{16}$/);
    expect(JSON.stringify(c)).not.toContain(KEY);
  });

  it("a credential signed before a rotation verifies under the previous key", () => {
    process.env.PROVENANCE_SIGNING_KEY = OLD;
    const before = emitProvenance(IMG, { model: "m" });
    process.env.PROVENANCE_SIGNING_KEY = KEY;
    process.env.PROVENANCE_SIGNING_KEY_PREVIOUS = OLD;
    const after = emitProvenance(IMG, { model: "m" });
    expect(after.keyId).toBe(provenanceKeyId(KEY));
    expect(verifyProvenance(before, IMG)).toBe(true);
    expect(verifyProvenance(after, IMG)).toBe(true);
    // Once the previous key is removed, what it signed no longer verifies.
    delete process.env.PROVENANCE_SIGNING_KEY_PREVIOUS;
    expect(verifyProvenance(before, IMG)).toBe(false);
    expect(verifyProvenance(after, IMG)).toBe(true);
  });

  it("refuses a credential naming a key the ring does not hold, or another key's id", () => {
    const c = emitProvenance(IMG, { model: "m" });
    expect(verifyProvenance({ ...c, keyId: "k-0000000000000000" }, IMG)).toBe(false);
    expect(verifyProvenance({ ...c, keyId: "" }, IMG)).toBe(false);
    process.env.PROVENANCE_SIGNING_KEY_PREVIOUS = OLD;
    expect(verifyProvenance({ ...c, keyId: provenanceKeyId(OLD) }, IMG)).toBe(false);
  });

  it("the media type and bytes cannot trade a separator (mediaType|data was ambiguous)", () => {
    const a = { mediaType: "image/png", data: "x|y" };
    const b = { mediaType: "image/png|x", data: "y" };
    const c = emitProvenance(a, { model: "m" });
    expect(verifyProvenance(c, a)).toBe(true);
    expect(verifyProvenance(c, b)).toBe(false);
    const legacy = (i: { mediaType: string; data: string }) =>
      createHash("sha256").update(i.mediaType).update("|").update(i.data).digest("hex");
    expect(legacy(a)).toBe(legacy(b));
  });

  it("issues a signed credential only for an allowed image type", () => {
    for (const mediaType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      const img = { mediaType, data: "aGVsbG8=" };
      expect(verifyProvenance(emitProvenance(img, { model: "m" }), img)).toBe(true);
    }
    for (const mediaType of ["image/svg+xml", "text/html", "image/png; x=1", ""]) {
      const img = { mediaType, data: "aGVsbG8=" };
      const c = emitProvenance(img, { model: "m" });
      expect([mediaType, c.signature]).toEqual([mediaType, ""]);
      expect(verifyProvenance(c, img)).toBe(false);
      // Nor does a valid credential verify against the same bytes declared another type.
      expect(
        verifyProvenance(emitProvenance(IMG, { model: "m" }), { ...IMG, mediaType })
      ).toBe(false);
    }
  });
});

describe("synthetic-origin detection", () => {
  it("treats content as possibly synthetic when no detector is configured (fail closed)", async () => {
    expect(await detectSyntheticOrigin(IMG)).toEqual({
      synthetic: true,
      confidence: 0,
      unconfigured: true,
    });
  });

  it("returns the injected detector's signal (a signal, not a gate)", async () => {
    setSyntheticDetector(async () => ({ synthetic: true, confidence: 0.9 }));
    const s = await detectSyntheticOrigin(IMG);
    expect(s.synthetic).toBe(true);
    expect(s.confidence).toBeCloseTo(0.9);
  });

  it("a detector that throws, or answers nonsense, yields synthetic", async () => {
    setSyntheticDetector(async () => {
      throw new Error("down");
    });
    expect((await detectSyntheticOrigin(IMG)).synthetic).toBe(true);
    setSyntheticDetector(async () => ({}) as never);
    expect((await detectSyntheticOrigin(IMG)).synthetic).toBe(true);
  });

  it("a clean detector's answer stands", async () => {
    setSyntheticDetector(async () => ({ synthetic: false, confidence: 0.1 }));
    expect((await detectSyntheticOrigin(IMG)).synthetic).toBe(false);
  });
});
