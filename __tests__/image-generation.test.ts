/**
 * __tests__/image-generation.test.ts — a held image is delivered after approval, an image too large
 * to hold is withheld saying so, and a replay whose image was not kept never offers the marker as
 * an image (platform TASK-229, reviews TA-a-4 and code review B-1; T14)
 *
 * What it refuses: a held generation that can never be delivered (each approval paying for another
 * generation), or a replayed generation that returns or screens the "not kept" marker as an image
 *
 * The draft is an external effect (ADR-045): a retry with the same operation id replays the ledger
 * instead of generating again. The high-risk flow depends on that: call 1 generates and answers
 * `held`; after approval, call 2 replays the receipt and commits it. The ledger keeps a receipt
 * that prints up to EFFECT_RECEIPT_MAX_TEXT (6 MiB) — an image of about 4.4 MiB. Code review B-1:
 * with the 1 MiB of other stored documents, every image over ~768 KB was held, approved, found
 * "no longer available", generated again, held again — a paid generation per round. Now:
 *   - a 2 MB image is held, approved and committed, generated once;
 *   - an image larger than the ledger keeps is `withheld` on its first call, with
 *     screens.moderation.image.too_large_to_hold and the limit — no approval is asked for;
 *   - a replay of a receipt that was not kept answers `held` with
 *     screens.moderation.image.not_kept, and the generator is not called.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { generateGoverned, type ImageGenerator } from "@/platform/ai";
import {
  getEffectLedger,
  getProposalStore,
  resetEffectLedger,
  resetProposalStore,
} from "@/platform/agents";
import { resetModalityClassifiers, setModalityClassifiers } from "@/platform/moderation";
import {
  EFFECT_RECEIPT_MAX_IMAGE_BYTES,
  EFFECT_RECEIPT_MAX_TEXT,
  isOmittedMarker,
} from "@/platform/errors/json-limits";
import en from "@/messages/en.json";

beforeEach(() => {
  resetEffectLedger();
  resetProposalStore();
  setModalityClassifiers({
    hardRefuse: async () => false,
    nsfw: async () => ({ axis: "nsfw", action: "allow" }),
    realPerson: async () => ({ axis: "real-person", action: "allow" }),
    baseline: async () => ({ axis: "baseline", action: "allow" }),
  });
});
afterEach(() => {
  resetEffectLedger();
  resetProposalStore();
  resetModalityClassifiers();
});

/** An image of `bytes` bytes, as the base64 a generator returns. */
const image = (bytes: number) => ({
  mediaType: "image/png",
  data: Buffer.alloc(bytes, 7).toString("base64"),
});
const approval = {
  actor: { actorType: "agent" as const, actorId: "painter", agentRole: "painter" },
  sessionId: "s1",
  trajectoryId: "t1",
};

describe("code review B-1: a held image is kept for its approval", () => {
  it("[guard] a 2 MB image from a guest: held, approved, committed with that image — generated once", async () => {
    const big = image(2 * 1_048_576);
    let calls = 0;
    const generator: ImageGenerator = async () => {
      calls++;
      return big;
    };
    const request = {
      prompt: "x",
      operationId: "op-held",
      requesterTrust: "guest" as const,
    };
    const first = await generateGoverned(request, generator, {
      requestId: "r",
      approvalContext: approval,
    });
    expect(first.status).toBe("held");
    expect(first.reason).toEqual({ key: "screens.moderation.image.held" });
    expect(first.image).toBeUndefined();
    // The ledger kept the image itself, not the marker.
    const entry = await getEffectLedger().get("op-held", "image-generation");
    expect(isOmittedMarker(entry?.receipt)).toBe(false);
    expect((entry?.receipt as { data: string }).data).toHaveLength(big.data.length);

    await getProposalStore().decide(first.proposalId!, "approved", "approver-1");
    const second = await generateGoverned(request, generator, {
      requestId: "r",
      approvedProposalId: first.proposalId,
    });
    expect(second.status).toBe("committed");
    expect(second.image).toEqual(big);
    expect(calls).toBe(1);
  });

  it("[guard] an image larger than the ledger keeps, from a guest: withheld with the limit — never held for an approval that could not deliver it", async () => {
    const huge = image(EFFECT_RECEIPT_MAX_TEXT); // base64: a third more than the limit
    let calls = 0;
    const generator: ImageGenerator = async () => {
      calls++;
      return huge;
    };
    const out = await generateGoverned(
      { prompt: "x", operationId: "op-huge", requesterTrust: "guest" },
      generator,
      { requestId: "r", approvalContext: approval }
    );
    expect(out.status).toBe("withheld");
    expect(out.reason).toEqual({
      key: "screens.moderation.image.too_large_to_hold",
      params: { max: EFFECT_RECEIPT_MAX_IMAGE_BYTES },
    });
    expect(out.proposalId).toBeUndefined();
    expect(out.image).toBeUndefined();
    expect(await getProposalStore().query({ operationId: "op-huge" })).toEqual([]);
    expect(calls).toBe(1);
    expect(en.screens.moderation.image.too_large_to_hold).toContain("{max, number}");
  });

  it("the largest image a held generation keeps (EFFECT_RECEIPT_MAX_IMAGE_BYTES) is kept; a trusted requester's larger image still commits at once", async () => {
    const most = image(EFFECT_RECEIPT_MAX_IMAGE_BYTES);
    const held = await generateGoverned(
      { prompt: "x", operationId: "op-most", requesterTrust: "guest" },
      async () => most,
      { requestId: "r", approvalContext: approval }
    );
    expect(held.status).toBe("held");
    const huge = image(EFFECT_RECEIPT_MAX_TEXT);
    const low = await generateGoverned(
      { prompt: "x", operationId: "op-low", requesterTrust: "trusted" },
      async () => huge,
      { requestId: "r" }
    );
    expect(low.status).toBe("committed");
    expect(low.image).toEqual(huge);
  });
});

describe("T14: a replay whose image was not kept", () => {
  it("[guard] held, saying the earlier image is no longer available; nothing generated", async () => {
    // A trusted requester's image over the limit committed at once; its receipt is the marker.
    const huge = image(EFFECT_RECEIPT_MAX_TEXT);
    const request = {
      prompt: "x",
      operationId: "op-img",
      requesterTrust: "trusted" as const,
    };
    const first = await generateGoverned(request, async () => huge, { requestId: "r" });
    expect(first.status).toBe("committed");
    const entry = await getEffectLedger().get("op-img", "image-generation");
    expect(entry?.receipt).toEqual({
      _omitted: { code: "request.json_too_large", max: EFFECT_RECEIPT_MAX_TEXT },
    });
    let calls = 0;
    const generator: ImageGenerator = async () => {
      calls++;
      return { mediaType: "image/png", data: "aGk=" };
    };
    const out = await generateGoverned(request, generator, { requestId: "r" });
    expect(calls).toBe(0);
    expect(out.status).toBe("held");
    expect(out.reason).toEqual({ key: "screens.moderation.image.not_kept" });
    expect((out as { image?: unknown }).image).toBeUndefined();
    expect(en.screens.moderation.image.not_kept).toBe(
      "The earlier image is no longer available; generate it again."
    );
  });
});
