/**
 * __tests__/contract/ai-provider-contract.ts
 * AIProvider conformance kit (TCK) — ADR-027. Not a *.test.ts.
 *
 * stream() is optional in the interface; the streaming assertion is skipped
 * for implementations that do not provide it.
 */

import type { AIProvider, AIStreamChunk } from "@/platform/ai/types";

export interface AIContractFixtures {
  makeProvider: () => AIProvider | Promise<AIProvider>;
}

export function runAIProviderContract(fx: AIContractFixtures): void {
  let provider: AIProvider;

  beforeEach(async () => {
    provider = await fx.makeProvider();
  });

  describe("name", () => {
    it("exposes a non-empty provider name", () => {
      expect(typeof provider.name).toBe("string");
      expect(provider.name.length).toBeGreaterThan(0);
    });
  });

  describe("complete", () => {
    it("returns a well-formed response", async () => {
      const r = await provider.complete({
        tier: "fast",
        messages: [{ role: "user", content: "Say hello." }],
        maxTokens: 64,
      });
      expect(Array.isArray(r.content)).toBe(true);
      expect(r.content.length).toBeGreaterThan(0);
      expect(typeof r.model).toBe("string");
      expect(r.model.length).toBeGreaterThan(0);
      expect(r.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(r.usage.outputTokens).toBeGreaterThanOrEqual(0);
      expect(typeof r.stopReason).toBe("string");
    });

    it("returns at least one text block", async () => {
      const r = await provider.complete({
        tier: "fast",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 32,
      });
      const hasText = r.content.some((b) => b.type === "text");
      expect(hasText).toBe(true);
    });
  });

  describe("stream (optional)", () => {
    it("streams chunks ending with done=true when supported", async () => {
      if (!provider.stream) return;
      const chunks: AIStreamChunk[] = [];
      for await (const c of provider.stream({
        tier: "fast",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 32,
      })) {
        chunks.push(c);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].done).toBe(true);
    });
  });
}
