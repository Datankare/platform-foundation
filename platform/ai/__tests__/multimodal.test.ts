/**
 * multimodal.test.ts — the shared multimodal substrate helpers (ADR-044 D3/D6).
 */
import { degradeToSupported, requestModalities, blockModality } from "../multimodal";
import type { AIRequest, ProviderCapabilities } from "../types";

const img = { type: "image", source: { mediaType: "image/png", data: "x" } } as const;
const aud = { type: "audio", source: { mediaType: "audio/wav", data: "y" } } as const;
const req = (content: AIRequest["messages"][number]["content"]): AIRequest => ({
  tier: "standard",
  maxTokens: 32,
  messages: [{ role: "user", content }],
});
const caps = (inputs: ProviderCapabilities["inputs"]): ProviderCapabilities => ({
  inputs,
  outputs: ["text"],
});

describe("multimodal substrate", () => {
  it("blockModality classifies blocks", () => {
    expect(blockModality(img)).toBe("image");
    expect(blockModality(aud)).toBe("audio");
    expect(blockModality({ type: "text", text: "t" })).toBe("text");
  });

  it("requestModalities collects present modalities", () => {
    const m = requestModalities(req([{ type: "text", text: "t" }, img]));
    expect([...m].sort()).toEqual(["image", "text"]);
  });

  it("keeps supported modalities", () => {
    const { request, dropped } = degradeToSupported(
      req([{ type: "text", text: "t" }, img]),
      caps(["text", "image"])
    );
    expect(request.messages[0].content).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it("drops unsupported modalities, keeps text, reports what was dropped", () => {
    const { request, dropped } = degradeToSupported(
      req([{ type: "text", text: "t" }, img, aud]),
      caps(["text"])
    );
    const blocks = request.messages[0].content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text"]);
    expect(dropped.sort()).toEqual(["audio", "image"]);
  });

  it("leaves string content untouched", () => {
    const { request, dropped } = degradeToSupported(req("plain text"), caps(["text"]));
    expect(request.messages[0].content).toBe("plain text");
    expect(dropped).toEqual([]);
  });
});
