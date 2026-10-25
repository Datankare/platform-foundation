/**
 * multimodal-screening-conformance.test.ts — ADR-046 L21: the screenModality seam satisfies
 * the multimodal-screening contract.
 */
import { runMultimodalScreeningContract } from "./contract/multimodal-screening-contract";
import {
  screenModality,
  setModalityClassifiers,
  resetModalityClassifiers,
  screenPermits,
  modalityClassifiersConfigured,
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

describe("unconfigured classifiers (audit X-18)", () => {
  const ITEMS = [
    { modality: "image" as const, mediaType: "image/png", data: "x" },
    { modality: "audio" as const, mediaType: "audio/wav", data: "" },
  ];
  it.each(ITEMS)(
    "withholds every $modality item until an app sets classifiers",
    async (item) => {
      expect(modalityClassifiersConfigured()).toBe(false);
      for (const direction of ["input", "output"] as const) {
        const r = await screenModality(item, { direction, requestId: "r" });
        expect(screenPermits(r)).toBe(false);
        expect(r.action).toBe("escalate");
        expect(r.reasoning).toMatch(/no classifier configured/);
      }
    }
  );

  it("a classifier answering a non-action has not cleared the item", async () => {
    setModalityClassifiers({
      hardRefuse: async () => false,
      nsfw: async () => ({ axis: "nsfw", action: "allow" }),
      realPerson: async () =>
        ({ axis: "real-person", action: "ALLOW" }) as unknown as Awaited<
          ReturnType<ModalityClassifiers["realPerson"]>
        >,
      baseline: async () => undefined as never,
    });
    expect(modalityClassifiersConfigured()).toBe(true);
    const r = await screenModality(ITEMS[0], { direction: "input", requestId: "r" });
    expect(screenPermits(r)).toBe(false);
  });
});
