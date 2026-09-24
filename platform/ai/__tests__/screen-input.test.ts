/**
 * screen-input.test.ts — ADR-044 D4: multimodal input is screened before dispatch and
 * refused fail-closed on block/escalate.
 */
import { screenMultimodalInput } from "../screen-input";
import { createOrchestrator } from "../index";
import type { AIProvider, AIRequest, AIResponse } from "../types";
import {
  setModalityClassifiers,
  resetModalityClassifiers,
  type ModalityClassifiers,
} from "@/platform/moderation";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

function classifiers(over: Partial<ModalityClassifiers>): ModalityClassifiers {
  return {
    hardRefuse: async () => false,
    nsfw: async () => ({ axis: "nsfw", action: "allow" }),
    realPerson: async () => ({ axis: "real-person", action: "allow" }),
    baseline: async () => ({ axis: "baseline", action: "allow" }),
    ...over,
  } as ModalityClassifiers;
}
const imageReq: AIRequest = {
  tier: "standard",
  maxTokens: 64,
  messages: [
    {
      role: "user",
      content: [{ type: "image", source: { mediaType: "image/png", data: "x" } }],
    },
  ],
};
const textReq: AIRequest = {
  tier: "standard",
  maxTokens: 64,
  messages: [{ role: "user", content: "hello" }],
};
function captureProvider(): AIProvider {
  return {
    name: "capture",
    capabilities: { inputs: ["text", "image", "audio"], outputs: ["text"] },
    async complete(_r: AIRequest): Promise<AIResponse> {
      return {
        content: [{ type: "text", text: "ok" }],
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

afterEach(() => resetModalityClassifiers());

describe("screenMultimodalInput", () => {
  it("permits allowed image input", async () => {
    setModalityClassifiers(classifiers({}));
    expect((await screenMultimodalInput(imageReq, "r")).refused).toBe(false);
  });
  it("refuses a blocked image (fail-closed)", async () => {
    setModalityClassifiers(
      classifiers({ nsfw: async () => ({ axis: "nsfw", action: "block" }) })
    );
    expect((await screenMultimodalInput(imageReq, "r")).refused).toBe(true);
  });
  it("refuses on escalate", async () => {
    setModalityClassifiers(
      classifiers({
        realPerson: async () => ({ axis: "real-person", action: "escalate" }),
      })
    );
    expect((await screenMultimodalInput(imageReq, "r")).refused).toBe(true);
  });
  it("ignores text-only requests (nothing multimodal to screen)", async () => {
    expect((await screenMultimodalInput(textReq, "r")).refused).toBe(false);
  });
});

describe("orchestrator withholds blocked multimodal input", () => {
  it("throws when an input image is blocked", async () => {
    setModalityClassifiers(classifiers({ hardRefuse: async () => true }));
    const orch = createOrchestrator({ provider: captureProvider() });
    await expect(
      orch.complete(imageReq, { useCase: "test", requestId: "r" })
    ).rejects.toThrow(/withheld by screening/);
  });
  it("proceeds when input is allowed", async () => {
    setModalityClassifiers(classifiers({}));
    const orch = createOrchestrator({ provider: captureProvider() });
    const res = await orch.complete(imageReq, { useCase: "test", requestId: "r" });
    expect(res.content[0]).toEqual({ type: "text", text: "ok" });
  });
});
