/**
 * provenance-conformance.test.ts — ADR-047 L21: the provenance seam satisfies the contract.
 */
import { runProvenanceContract } from "./contract/provenance-contract";
import { emitProvenance, verifyProvenance, detectSyntheticOrigin } from "@/platform/ai";

runProvenanceContract({
  name: "provenance seam",
  emit: (image, model) => emitProvenance(image, { model }),
  verify: verifyProvenance,
  detect: detectSyntheticOrigin,
});
