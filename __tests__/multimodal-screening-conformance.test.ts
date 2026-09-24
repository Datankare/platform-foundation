/**
 * multimodal-screening-conformance.test.ts — ADR-046 L21: the screenModality seam satisfies
 * the multimodal-screening contract.
 */
import { runMultimodalScreeningContract } from "./contract/multimodal-screening-contract";
import {
  screenModality,
  setModalityClassifiers,
  resetModalityClassifiers,
  type ModalityClassifiers,
} from "@/platform/moderation/screen-modality";

afterEach(() => resetModalityClassifiers());

runMultimodalScreeningContract({
  name: "screenModality seam",
  screenWith: async (f) => {
    const mk =
      (axis: "nsfw" | "real-person" | "baseline", action?: string) => async () => {
        if (f.error) throw new Error("classifier down");
        return { axis, action: action ?? "allow" };
      };
    const classifiers: ModalityClassifiers = {
      hardRefuse: async () => f.hardRefuse ?? false,
      nsfw: mk("nsfw", f.nsfw) as ModalityClassifiers["nsfw"],
      realPerson: mk("real-person", f.realPerson) as ModalityClassifiers["realPerson"],
      baseline: mk("baseline", f.baseline) as ModalityClassifiers["baseline"],
    };
    setModalityClassifiers(classifiers);
    return screenModality(
      { modality: "image", mediaType: "image/png", data: "x" },
      { direction: f.direction ?? "input", requestId: "r" }
    );
  },
});
