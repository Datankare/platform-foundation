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
import { resetEffectLedger } from "@/platform/agents";

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

beforeEach(() => {
  resetEffectLedger();
  setModalityClassifiers(classifiers({}));
  resetGenerationRiskPolicy();
});
afterEach(() => {
  resetModalityClassifiers();
  resetGenerationRiskPolicy();
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
});
