/**
 * __tests__/contract/multimodal-screening-contract.ts — ADR-046 L21 multimodal-screening kit.
 *
 * The provider-agnostic contract for the screenModality seam: both directions screen, the seam
 * fails closed, the safety axes fire independently, and the hard-refuse invariants refuse
 * regardless of configuration. Run it with a harness that screens content under forced axis /
 * invariant outcomes.
 */
import type { ModerationAction, ScreeningDirection } from "@/platform/moderation/types";
import type { ModalityScreenResult } from "@/platform/moderation/screen-modality";

export interface MultimodalScreeningHarness {
  readonly name: string;
  readonly screenWith: (forced: {
    hardRefuse?: boolean;
    nsfw?: ModerationAction;
    realPerson?: ModerationAction;
    baseline?: ModerationAction;
    error?: boolean;
    direction?: ScreeningDirection;
  }) => Promise<ModalityScreenResult>;
}

export function runMultimodalScreeningContract(h: MultimodalScreeningHarness): void {
  describe(`multimodal screening contract — ${h.name} (ADR-046 L21)`, () => {
    it("screens input-direction content", async () => {
      const r = await h.screenWith({ direction: "input", nsfw: "allow" });
      expect(r).toHaveProperty("action");
    });

    it("screens output-direction (generated) content", async () => {
      const r = await h.screenWith({ direction: "output", nsfw: "allow" });
      expect(r).toHaveProperty("action");
    });

    it("permits when every axis allows", async () => {
      const r = await h.screenWith({
        nsfw: "allow",
        realPerson: "allow",
        baseline: "allow",
      });
      expect(r.action).toBe("allow");
    });

    it("blocks when an axis blocks (fail-closed withhold)", async () => {
      const r = await h.screenWith({ nsfw: "block" });
      expect(r.action).toBe("block");
    });

    it("axes fire independently — real-person escalates while NSFW is clean", async () => {
      const r = await h.screenWith({ nsfw: "allow", realPerson: "escalate" });
      expect(r.action).toBe("escalate");
    });

    it("a screener error fails closed to escalate", async () => {
      const r = await h.screenWith({ error: true });
      expect(r.action).toBe("escalate");
    });

    it("hard-refuse invariant refuses regardless of axis configuration", async () => {
      // every tunable axis set to allow; the invariant must still block
      const r = await h.screenWith({
        hardRefuse: true,
        nsfw: "allow",
        realPerson: "allow",
        baseline: "allow",
      });
      expect(r.action).toBe("block");
      expect(r.hardRefused).toBe(true);
    });
  });
}
