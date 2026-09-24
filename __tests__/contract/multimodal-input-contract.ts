/**
 * __tests__/contract/multimodal-input-contract.ts — ADR-044 L21 multimodal-input kit.
 *
 * The provider-agnostic contract for modality-aware input routing (ADR-044 D3): a request's
 * content reaches a capable provider intact, and degrades to text — fail-closed by omission —
 * against a provider that does not declare the modality. Run it with a harness that reports
 * what the provider actually received after the pipeline's degradation.
 */
import type { AIRequest, AIContentBlock, ProviderCapabilities } from "@/platform/ai";

export interface MultimodalInputHarness {
  readonly name: string;
  /** Send `request` through the pipeline against a provider declaring `caps`; resolve what the provider received. */
  readonly received: (
    caps: ProviderCapabilities,
    request: AIRequest
  ) => Promise<AIRequest>;
}

function blocksOf(request: AIRequest): AIContentBlock[] {
  const last = request.messages[request.messages.length - 1];
  return typeof last.content === "string" ? [] : last.content;
}
const IMG: AIContentBlock = {
  type: "image",
  source: { mediaType: "image/png", data: "aGVsbG8=" },
};
const AUD: AIContentBlock = {
  type: "audio",
  source: { mediaType: "audio/wav", data: "aGVsbG8=" },
};
const imageRequest: AIRequest = {
  tier: "standard",
  maxTokens: 64,
  messages: [{ role: "user", content: [{ type: "text", text: "describe" }, IMG] }],
};
const audioRequest: AIRequest = {
  tier: "standard",
  maxTokens: 64,
  messages: [{ role: "user", content: [{ type: "text", text: "transcribe" }, AUD] }],
};

export function runMultimodalInputContract(h: MultimodalInputHarness): void {
  const caps = (inputs: ProviderCapabilities["inputs"]): ProviderCapabilities => ({
    inputs,
    outputs: ["text"],
  });

  describe(`multimodal input contract — ${h.name} (ADR-044 L21)`, () => {
    it("an image-capable provider receives the image block intact", async () => {
      const got = await h.received(caps(["text", "image"]), imageRequest);
      expect(blocksOf(got).some((b) => b.type === "image")).toBe(true);
      expect(blocksOf(got).some((b) => b.type === "text")).toBe(true);
    });

    it("a text-only provider degrades the image away, keeps text (fail-closed by omission)", async () => {
      const got = await h.received(caps(["text"]), imageRequest);
      expect(blocksOf(got).some((b) => b.type === "image")).toBe(false);
      expect(blocksOf(got).some((b) => b.type === "text")).toBe(true);
    });

    it("an undeclared modality (audio) never reaches a text+image provider", async () => {
      const got = await h.received(caps(["text", "image"]), audioRequest);
      expect(blocksOf(got).some((b) => b.type === "audio")).toBe(false);
    });

    it("an audio-capable provider receives the audio block", async () => {
      const got = await h.received(caps(["text", "audio"]), audioRequest);
      expect(blocksOf(got).some((b) => b.type === "audio")).toBe(true);
    });
  });
}
