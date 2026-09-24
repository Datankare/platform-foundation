/**
 * generation-lifecycle-conformance.test.ts — ADR-045 L21: generateGoverned satisfies the
 * governed-generation contract.
 */
import { runGenerationLifecycleContract } from "./contract/generation-lifecycle-contract";
import {
  generateGoverned,
  type ImageGenerator,
  type GenerationRequest,
} from "@/platform/ai";
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

afterEach(() => {
  resetModalityClassifiers();
  resetEffectLedger();
});

runGenerationLifecycleContract({
  name: "generateGoverned",
  run: async (scenario) => {
    resetEffectLedger();
    const action = scenario.screen ?? "allow";
    const classifiers: ModalityClassifiers = {
      hardRefuse: async () => false,
      nsfw: async () => ({ axis: "nsfw", action }),
      realPerson: async () => ({ axis: "real-person", action: "allow" }),
      baseline: async () => ({ axis: "baseline", action: "allow" }),
    };
    setModalityClassifiers(classifiers);
    let generatorCalls = 0;
    const generator: ImageGenerator = async () => {
      generatorCalls++;
      return { mediaType: "image/png", data: "aGk=" };
    };
    const request: GenerationRequest = {
      prompt: "x",
      operationId: "op-fixed",
      requesterTrust: scenario.trust ?? "trusted",
    };
    const first = await generateGoverned(request, generator, { requestId: "r" });
    if (scenario.retry) await generateGoverned(request, generator, { requestId: "r" });
    return { status: first.status, generatorCalls };
  },
});
