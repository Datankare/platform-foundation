/**
 * provenance-conformance.test.ts — ADR-047 L21: the provenance seam satisfies the contract.
 */
import { runProvenanceContract } from "./contract/provenance-contract";
import { emitProvenance, verifyProvenance, detectSyntheticOrigin } from "@/platform/ai";

const KEY = "provenance-conformance-key-0123456789abcdef";
beforeAll(() => {
  process.env.PROVENANCE_SIGNING_KEY = KEY;
});
afterAll(() => {
  delete process.env.PROVENANCE_SIGNING_KEY;
});

runProvenanceContract({
  name: "provenance seam",
  emit: (image, model) => emitProvenance(image, { model }),
  verify: verifyProvenance,
  detect: detectSyntheticOrigin,
});
