/**
 * screen-modality.test.ts — the multimodal screening seam (ADR-046).
 */
import {
  screenModality,
  setModalityClassifiers,
  resetModalityClassifiers,
  mostRestrictive,
  screenPermits,
  type ModalityClassifiers,
  type ModalityContent,
} from "../screen-modality";

const IMG: ModalityContent = { modality: "image", mediaType: "image/png", data: "x" };
const OPTS = { direction: "input" as const, requestId: "r" };
function classifiers(over: Partial<ModalityClassifiers>): ModalityClassifiers {
  return {
    hardRefuse: async () => false,
    nsfw: async () => ({ axis: "nsfw", action: "allow" }),
    realPerson: async () => ({ axis: "real-person", action: "allow" }),
    baseline: async () => ({ axis: "baseline", action: "allow" }),
    ...over,
  } as ModalityClassifiers;
}

afterEach(() => resetModalityClassifiers());

describe("screenModality", () => {
  it("mostRestrictive picks the worst action", () => {
    expect(mostRestrictive(["allow", "warn", "allow"])).toBe("warn");
    expect(mostRestrictive(["allow", "escalate", "block"])).toBe("block");
    expect(mostRestrictive(["allow", "allow"])).toBe("allow");
  });

  it("hard-refuse fires first, above the axes, non-configurable", async () => {
    setModalityClassifiers(
      classifiers({
        hardRefuse: async () => true,
        // even if every axis would allow, hard-refuse blocks
      })
    );
    const r = await screenModality(IMG, OPTS);
    expect(r.action).toBe("block");
    expect(r.hardRefused).toBe(true);
    expect(r.axes).toHaveLength(0);
  });

  it("axes fire independently — a real-person hit escalates even when NSFW is clean", async () => {
    setModalityClassifiers(
      classifiers({
        realPerson: async () => ({ axis: "real-person", action: "escalate" }),
      })
    );
    const r = await screenModality(IMG, OPTS);
    expect(r.action).toBe("escalate");
    expect(r.hardRefused).toBe(false);
  });

  it("allow across all axes permits", async () => {
    setModalityClassifiers(classifiers({}));
    const r = await screenModality(IMG, OPTS);
    expect(r.action).toBe("allow");
    expect(screenPermits(r)).toBe(true);
  });

  it("a classifier error fails closed to escalate", async () => {
    setModalityClassifiers(
      classifiers({
        nsfw: async () => {
          throw new Error("classifier down");
        },
      })
    );
    const r = await screenModality(IMG, OPTS);
    expect(r.action).toBe("escalate");
    expect(screenPermits(r)).toBe(false);
  });
});
