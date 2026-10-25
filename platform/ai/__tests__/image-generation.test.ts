/**
 * image-generation.test.ts — governed image generation lifecycle (ADR-045).
 */
import {
  generateGoverned,
  setGenerationRiskPolicy,
  resetGenerationRiskPolicy,
  type GenerationRequest,
  type ImageGenerator,
} from "../image-generation";
import {
  setModalityClassifiers,
  resetModalityClassifiers,
  type ModalityClassifiers,
} from "@/platform/moderation";
import {
  resetEffectLedger,
  getProposalStore,
  resetProposalStore,
} from "@/platform/agents";
import {
  emitProvenance,
  verifyProvenance,
  setSyntheticDetector,
  resetSyntheticDetector,
} from "../provenance";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const IMG = { mediaType: "image/png", data: "aGk=" };
function classifiers(over: Partial<ModalityClassifiers>): ModalityClassifiers {
  return {
    hardRefuse: async () => false,
    nsfw: async () => ({ axis: "nsfw", action: "allow" }),
    realPerson: async () => ({ axis: "real-person", action: "allow" }),
    baseline: async () => ({ axis: "baseline", action: "allow" }),
    ...over,
  } as ModalityClassifiers;
}
let opSeq = 0;
const req = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  prompt: "a cat",
  operationId: over.operationId ?? `op-${++opSeq}`,
  requesterTrust: "trusted",
  ...over,
});
const OPTS = { requestId: "r" };

beforeAll(() => {
  process.env.PROVENANCE_SIGNING_KEY = "image-generation-test-key-0123456789abcdef";
});
afterAll(() => {
  delete process.env.PROVENANCE_SIGNING_KEY;
});

beforeEach(() => {
  resetEffectLedger();
  resetProposalStore();
  resetSyntheticDetector();
  setModalityClassifiers(classifiers({}));
  resetGenerationRiskPolicy();
});
afterEach(() => {
  resetModalityClassifiers();
  resetGenerationRiskPolicy();
  resetSyntheticDetector();
});

describe("generateGoverned", () => {
  const gen: ImageGenerator = async () => IMG;

  it("commits a clean, trusted, low-risk generation", async () => {
    const r = await generateGoverned(req(), gen, OPTS);
    expect(r.status).toBe("committed");
    expect(r.image).toEqual(IMG);
    expect(r.tier).toBe("low");
  });

  it("withholds a blocked draft (fail-closed, never surfaced)", async () => {
    setModalityClassifiers(
      classifiers({ nsfw: async () => ({ axis: "nsfw", action: "block" }) })
    );
    const r = await generateGoverned(req(), gen, OPTS);
    expect(r.status).toBe("withheld");
    expect(r.image).toBeUndefined();
  });

  it("withholds on escalate", async () => {
    setModalityClassifiers(
      classifiers({
        realPerson: async () => ({ axis: "real-person", action: "escalate" }),
      })
    );
    expect((await generateGoverned(req(), gen, OPTS)).status).toBe("withheld");
  });

  it("holds an untrusted requester's generation for Confirm (not surfaced)", async () => {
    const r = await generateGoverned(req({ requesterTrust: "guest" }), gen, OPTS);
    expect(r.status).toBe("held");
    expect(r.tier).toBe("high");
  });

  it("holds a trusted-but-warned image (default policy)", async () => {
    setModalityClassifiers(
      classifiers({ nsfw: async () => ({ axis: "nsfw", action: "warn" }) })
    );
    expect((await generateGoverned(req(), gen, OPTS)).status).toBe("held");
  });

  it("is idempotent — a retry with the same operationId never re-generates", async () => {
    let calls = 0;
    const counting: ImageGenerator = async () => {
      calls++;
      return IMG;
    };
    const r = req({ operationId: "stable-op" });
    await generateGoverned(r, counting, OPTS);
    await generateGoverned(r, counting, OPTS);
    expect(calls).toBe(1);
  });

  it("honours an injected admin risk policy", async () => {
    setGenerationRiskPolicy(() => "low");
    const r = await generateGoverned(req({ requesterTrust: "guest" }), gen, OPTS);
    expect(r.status).toBe("committed");
  });

  it("commits with a verifiable provenance credential (ADR-047)", async () => {
    const r = await generateGoverned(req(), gen, OPTS);
    expect(r.status).toBe("committed");
    expect(r.provenance).toBeDefined();
    expect(verifyProvenance(r.provenance!, r.image!)).toBe(true);
  });

  it("raises the tier to held when a reference image is flagged synthetic (ADR-047)", async () => {
    setSyntheticDetector(async () => ({ synthetic: true, confidence: 0.9 }));
    const r = await generateGoverned(
      req({ referenceImages: [{ mediaType: "image/png", data: "cmVm" }] }),
      gen,
      OPTS
    );
    expect(r.status).toBe("held");
    expect(r.tier).toBe("high");
  });

  describe("reference images (audit X-18)", () => {
    const REF = { mediaType: "image/png", data: "cmVm" };
    it("holds a generation from a reference when no detector is configured", async () => {
      const r = await generateGoverned(req({ referenceImages: [REF] }), gen, OPTS);
      expect(r.status).toBe("held");
      expect(r.image).toBeUndefined();
    });
    it("commits from a reference a configured detector clears", async () => {
      setSyntheticDetector(async () => ({ synthetic: false, confidence: 0.2 }));
      const r = await generateGoverned(req({ referenceImages: [REF] }), gen, OPTS);
      expect(r.status).toBe("committed");
    });
    it("a detector that throws counts as synthetic", async () => {
      setSyntheticDetector(async () => {
        throw new Error("detector down");
      });
      const r = await generateGoverned(req({ referenceImages: [REF] }), gen, OPTS);
      expect(r.status).toBe("held");
    });
    it.each([
      ["a credential that verifies (this platform's own generation)", true],
      ["a forged credential", false],
    ])("treats a reference carrying %s as synthetic", async (_label, genuine) => {
      setSyntheticDetector(async () => ({ synthetic: false, confidence: 0 }));
      const own = emitProvenance(REF, { model: "m" });
      const provenance = genuine ? own : { ...own, model: "someone-else" };
      expect(verifyProvenance(provenance, REF)).toBe(genuine);
      const r = await generateGoverned(
        req({ referenceImages: [{ ...REF, provenance }] }),
        gen,
        OPTS
      );
      expect(r.status).toBe("held");
      expect(r.tier).toBe("high");
    });
  });

  it("enqueues a held generation as a proposal given an approval context (ADR-040)", async () => {
    const ctx = {
      actor: { actorType: "agent" as const, actorId: "a", agentRole: "gen" },
      sessionId: "s",
      trajectoryId: "t",
    };
    const r = await generateGoverned(
      req({ requesterTrust: "guest", operationId: "held-op" }),
      gen,
      { ...OPTS, approvalContext: ctx }
    );
    expect(r.status).toBe("held");
    expect(r.proposalId).toBeDefined();
    const rec = await getProposalStore().getById(r.proposalId!);
    expect(rec?.label).toBe("image-generation");
  });
});

describe("a held generation surfaces nothing until it is approved (audit C-15)", () => {
  const ACTOR = { actorType: "agent" as const, actorId: "gen", agentRole: "gen" };
  const ctx = { actor: ACTOR, sessionId: "s", trajectoryId: "t" };

  it("returns no image while held, then commits the same draft once on approval", async () => {
    let calls = 0;
    const gen: ImageGenerator = async () => {
      calls++;
      return IMG;
    };
    const request = req({ requesterTrust: "user" });
    const held = await generateGoverned(request, gen, { ...OPTS, approvalContext: ctx });
    expect(held.status).toBe("held");
    expect(held.image).toBeUndefined();
    expect(held.proposalId).toEqual(expect.any(String));

    // Not yet approved: still nothing.
    const early = await generateGoverned(request, gen, {
      ...OPTS,
      approvedProposalId: held.proposalId,
    });
    expect(early.status).toBe("held");
    expect(early.image).toBeUndefined();

    await getProposalStore().decide(held.proposalId!, "approved", "approver");
    const committed = await generateGoverned(request, gen, {
      ...OPTS,
      approvedProposalId: held.proposalId,
    });
    expect(committed).toMatchObject({ status: "committed", image: IMG });
    expect(calls).toBe(1); // the stored draft, never a second generation

    const again = await generateGoverned(request, gen, {
      ...OPTS,
      approvedProposalId: held.proposalId,
    });
    expect(again.status).toBe("held");
    expect(again.image).toBeUndefined();
  });

  it("does not commit another request under the approval", async () => {
    const gen: ImageGenerator = async () => IMG;
    const held = await generateGoverned(req({ requesterTrust: "user" }), gen, {
      ...OPTS,
      approvalContext: ctx,
    });
    await getProposalStore().decide(held.proposalId!, "approved", "approver");
    const other = await generateGoverned(req({ requesterTrust: "user" }), gen, {
      ...OPTS,
      approvedProposalId: held.proposalId,
    });
    expect(other.status).toBe("held");
    expect(other.image).toBeUndefined();
  });
});
